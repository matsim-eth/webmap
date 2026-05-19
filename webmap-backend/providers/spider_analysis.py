"""Spider-analysis providers (inflow / outflow / both-flow).

Backed by ``spider_routes`` and ``spider_link_index`` inside
``synthetic.duckdb``. Person filters (sex, age, license, …) are applied
via JOIN onto ``persons``. The legacy ``home_canton`` parameter is
preserved as a convenience; new clients should pass ``polygon_id``.
"""

from __future__ import annotations

import duckdb

from .base import DataProvider, Param
from .connection import get_source_cursor
from .helpers import polygon_ids_from_params


def _get_con() -> duckdb.DuckDBPyConnection:
    """Cursor on synthetic.duckdb (where spider_routes/index live)."""
    return get_source_cursor("synthetic")


_SPIDER_PARAMS = [
    Param("link_id", "MATSim link ID to analyse", required=True),
    Param("sex", "Gender filter (0=male, 1=female)", enum=["0", "1"]),
    Param("age_min", "Minimum age (inclusive)", param_type="integer"),
    Param("age_max", "Maximum age (exclusive)", param_type="integer"),
    Param("employed", "Employment status", enum=["true", "false"]),
    Param("has_license", "Driving-licence filter", enum=["true", "false"]),
    Param("car_availability", "Car-availability class", enum=["always", "sometimes", "never", "0", "1", "2"]),
    Param("home_canton", "Canton name or ID (legacy, comma-separated)"),
    Param("polygon_id", "Hot-polygon ID(s) for home filter, comma-separated"),
    Param("income", "Income class (from households)"),
    Param("minute_start", "Time window start (minutes from midnight, 0-1440)", param_type="integer"),
    Param("minute_end", "Time window end (minutes from midnight, 0-1440)", param_type="integer"),
]


class _SpiderBase(DataProvider):
    def _build_filters(self, params: dict):
        """Return (person_filter_clauses, polygon_join, polygon_bind,
                  household_join, time_filter, bind_persons, bind_time)."""
        clauses: list[str] = []
        bind_persons: list = []

        sex = params.get("sex")
        if sex in ("0", "1"):
            clauses.append("AND p.sex = ?"); bind_persons.append(int(sex))
        try:
            if params.get("age_min") not in (None, ""):
                clauses.append("AND p.age >= ?"); bind_persons.append(int(params["age_min"]))
        except ValueError:
            pass
        try:
            if params.get("age_max") not in (None, ""):
                clauses.append("AND p.age < ?"); bind_persons.append(int(params["age_max"]))
        except ValueError:
            pass
        empl = (params.get("employed") or "").lower()
        if empl in ("true", "false"):
            clauses.append("AND p.employed = ?"); bind_persons.append(empl == "true")
        lic = (params.get("has_license") or "").lower()
        if lic in ("true", "false"):
            clauses.append("AND p.has_driving_license = ?"); bind_persons.append(lic == "true")
        ca = params.get("car_availability")
        if ca:
            ca_map = {"0": "always", "1": "sometimes", "2": "never",
                      "always": "always", "sometimes": "sometimes", "never": "never"}
            if ca in ca_map:
                clauses.append("AND p.car_availability = ?"); bind_persons.append(ca_map[ca])

        # Polygon-based home filter (replaces home_canton)
        polygon_join = ""
        polygon_bind: list = []
        polygon_ids = polygon_ids_from_params({**params, "canton": params.get("home_canton") or ""})
        if polygon_ids:
            placeholders = ",".join(["?"] * len(polygon_ids))
            polygon_join = f"""
                JOIN hot_polygons hp ON hp.polygon_id IN ({placeholders})
                   AND ST_Within(p.home_pt, hp.polygon_geom)
            """
            polygon_bind = polygon_ids

        income = params.get("income")
        household_join = ""
        if income not in (None, ""):
            try:
                clauses.append("AND CAST(h.income_class AS INTEGER) = ?"); bind_persons.append(int(income))
                household_join = "LEFT JOIN households h ON p.household_id = h.household_id"
            except ValueError:
                pass

        # Time filter on spider_link_index.departure_time
        time_clauses: list[str] = []
        bind_time: list = []
        try:
            if params.get("minute_start") not in (None, ""):
                time_clauses.append("AND idx.departure_time >= ?")
                bind_time.append(float(int(params["minute_start"]) * 60))
        except ValueError:
            pass
        try:
            if params.get("minute_end") not in (None, ""):
                time_clauses.append("AND idx.departure_time < ?")
                bind_time.append(float(int(params["minute_end"]) * 60))
        except ValueError:
            pass

        return (
            "\n            ".join(clauses),
            polygon_join, polygon_bind,
            household_join,
            "\n            ".join(time_clauses),
            bind_persons, bind_time,
        )

    def _person_subquery(self, polygon_join, household_join, person_clauses):
        """Return the subquery expression that resolves filtered person IDs."""
        return f"""
            SELECT p.person_id FROM persons p
            {polygon_join}
            {household_join}
            WHERE 1=1
            {person_clauses}
        """


# ─── Spider Inflow ──────────────────────────────────────────────────

class SpiderInflowProvider(_SpiderBase):
    ROUTE = "spider_inflow.json"
    PARAMS = _SPIDER_PARAMS

    def deliver(self, params: dict) -> dict:
        link_id = (params.get("link_id") or "").strip()
        if not link_id:
            return {"error": "link_id parameter is required"}
        person_clauses, poly_join, poly_bind, hh_join, time_filter, bind_persons, bind_time = \
            self._build_filters(params)
        con = _get_con()
        psubq = self._person_subquery(poly_join, hh_join, person_clauses)

        bind = poly_bind + bind_persons + [link_id] + bind_time
        try:
            rows = con.execute(f"""
                WITH target_trips AS (
                    SELECT idx.person_id, idx.trip_index, idx.position AS target_pos
                    FROM spider_link_index idx
                    INNER JOIN ({psubq}) fp ON idx.person_id = fp.person_id
                    WHERE idx.link_id = ?
                    {time_filter}
                ),
                tc AS (SELECT COUNT(*) AS total FROM target_trips),
                routes AS (
                    SELECT r.route_links, tt.target_pos
                    FROM spider_routes r
                    INNER JOIN target_trips tt
                      ON r.person_id = tt.person_id AND r.trip_index = tt.trip_index
                ),
                inflow AS (
                    SELECT UNNEST(route_links[:target_pos - 1]) AS link_id
                    FROM routes WHERE target_pos > 1
                )
                SELECT il.link_id, ROUND(COUNT(*)::DOUBLE / NULLIF(tc.total, 0), 6)
                FROM inflow il, tc
                GROUP BY il.link_id, tc.total
                ORDER BY 2 DESC
            """, bind).fetchall()
            total = con.execute(f"""
                SELECT COUNT(*) FROM spider_link_index idx
                INNER JOIN ({psubq}) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id = ? {time_filter}
            """, bind).fetchone()[0]
        except Exception as e:
            return {"error": str(e)}

        return {"target_link": link_id, "total_trips": int(total),
                "links": {r[0]: r[1] for r in rows}}


class SpiderOutflowProvider(_SpiderBase):
    ROUTE = "spider_outflow.json"
    PARAMS = _SPIDER_PARAMS

    def deliver(self, params: dict) -> dict:
        link_id = (params.get("link_id") or "").strip()
        if not link_id:
            return {"error": "link_id parameter is required"}
        person_clauses, poly_join, poly_bind, hh_join, time_filter, bind_persons, bind_time = \
            self._build_filters(params)
        con = _get_con()
        psubq = self._person_subquery(poly_join, hh_join, person_clauses)
        bind = poly_bind + bind_persons + [link_id] + bind_time
        try:
            rows = con.execute(f"""
                WITH target_trips AS (
                    SELECT idx.person_id, idx.trip_index, idx.position AS target_pos
                    FROM spider_link_index idx
                    INNER JOIN ({psubq}) fp ON idx.person_id = fp.person_id
                    WHERE idx.link_id = ? {time_filter}
                ),
                tc AS (SELECT COUNT(*) AS total FROM target_trips),
                routes AS (
                    SELECT r.route_links, tt.target_pos
                    FROM spider_routes r
                    INNER JOIN target_trips tt
                      ON r.person_id = tt.person_id AND r.trip_index = tt.trip_index
                ),
                outflow AS (
                    SELECT UNNEST(route_links[target_pos + 1:]) AS link_id
                    FROM routes WHERE target_pos < len(route_links)
                )
                SELECT ol.link_id, ROUND(COUNT(*)::DOUBLE / NULLIF(tc.total, 0), 6)
                FROM outflow ol, tc GROUP BY ol.link_id, tc.total ORDER BY 2 DESC
            """, bind).fetchall()
            total = con.execute(f"""
                SELECT COUNT(*) FROM spider_link_index idx
                INNER JOIN ({psubq}) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id = ? {time_filter}
            """, bind).fetchone()[0]
        except Exception as e:
            return {"error": str(e)}

        return {"target_link": link_id, "total_trips": int(total),
                "links": {r[0]: r[1] for r in rows}}


class SpiderOverlayProvider(_SpiderBase):
    ROUTE = "spider_bothflow.json"
    PARAMS = _SPIDER_PARAMS

    def deliver(self, params: dict) -> dict:
        link_id = (params.get("link_id") or "").strip()
        if not link_id:
            return {"error": "link_id parameter is required"}
        person_clauses, poly_join, poly_bind, hh_join, time_filter, bind_persons, bind_time = \
            self._build_filters(params)
        con = _get_con()
        psubq = self._person_subquery(poly_join, hh_join, person_clauses)
        bind = poly_bind + bind_persons + [link_id] + bind_time
        try:
            rows = con.execute(f"""
                WITH target_trips AS (
                    SELECT idx.person_id, idx.trip_index FROM spider_link_index idx
                    INNER JOIN ({psubq}) fp ON idx.person_id = fp.person_id
                    WHERE idx.link_id = ? {time_filter}
                )
                SELECT idx2.link_id, COUNT(*)::INTEGER FROM spider_link_index idx2
                INNER JOIN target_trips tt
                  ON idx2.person_id = tt.person_id AND idx2.trip_index = tt.trip_index
                GROUP BY idx2.link_id ORDER BY COUNT(*) DESC
            """, bind).fetchall()
            total = con.execute(f"""
                SELECT COUNT(*) FROM spider_link_index idx
                INNER JOIN ({psubq}) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id = ? {time_filter}
            """, bind).fetchone()[0]
        except Exception as e:
            return {"error": str(e)}

        return {"target_link": link_id, "total_trips": int(total),
                "links": {r[0]: int(r[1]) for r in rows}}

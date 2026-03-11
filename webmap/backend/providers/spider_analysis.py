"""Spider analysis endpoints using persistent DuckDB.

Three variants, all reading from spider.duckdb:

1. **SpiderInflowProvider** (spider_inflow.json)
   Links *before* the target — share (0-1).

2. **SpiderOutflowProvider** (spider_outflow.json)
   Links *after* the target — share (0-1).

3. **SpiderOverlayProvider** (spider_overlay.json)
   All links in full routes through target — absolute count.

Example (routes C→B→A, D→B→A, F→C→B→A  with target B):
  Inflow:  C=0.666, D=0.333, F=0.333   (links before B)
  Outflow: A=1.0                         (links after B)
  Overlay: B=3, A=3, C=2, D=1, F=1      (all links, absolute)

The DuckDB file contains:
  - spider_link_index: inverted index (link_id → trips), sorted by link_id
  - spider_routes:     full routes for inflow/outflow slicing
  - persons:           person attributes for filtering
  - households:        household attributes for income filter

Query params (shared)
---------------------
link_id          (str, required)       : MATSim link ID to analyse.
minute_start     (int, 0-1440)         : Time window start (minutes from midnight).
minute_end       (int, 0-1440)         : Time window end (minutes from midnight).
sex              (str, "0"/"1")        : Gender filter.
age_min          (int)                 : Minimum age (inclusive).
age_max          (int)                 : Maximum age (exclusive).
employed         (str, "true"/"false") : Employment status.
has_license      (str, "true"/"false") : Driving-licence filter.
car_availability (str, "0"/"1"/"2")    : Car-availability class.
home_canton      (str)                 : Canton name or ID (comma-separated).
income           (str)                 : Income class (from households).
"""

import duckdb

from .base import DataProvider
from .helpers import canton_filter_sql
from .paths import get_data_paths


# ─── Singleton DuckDB connection (read-only) ────────────────────────

_con: duckdb.DuckDBPyConnection | None = None


def _get_con() -> duckdb.DuckDBPyConnection:
    """Return a read-only connection to spider.duckdb (lazy singleton)."""
    global _con
    if _con is None:
        paths = get_data_paths()
        _con = duckdb.connect(paths.spider_db, read_only=True)
        _con.execute("SET memory_limit = '4GB'")
    return _con


# ─── Shared filter logic ─────────────────────────────────────────────

class _SpiderBase(DataProvider):
    """Common filter-building logic shared by all three spider endpoints."""

    def _build_filters(self, params: dict):
        """Return (person_filter_sql, household_join_sql, time_filter_sql,
                  bind_persons, bind_time)."""
        person_clauses: list[str] = []
        bind_persons: list = []

        # 1. sex
        sex = params.get("sex")
        if sex in ("0", "1"):
            person_clauses.append("AND p.sex = ?")
            bind_persons.append(int(sex))

        # 2. age_min
        age_min = params.get("age_min")
        if age_min is not None and age_min != "":
            try:
                person_clauses.append("AND p.age >= ?")
                bind_persons.append(int(age_min))
            except ValueError:
                pass

        # 3. age_max
        age_max = params.get("age_max")
        if age_max is not None and age_max != "":
            try:
                person_clauses.append("AND p.age < ?")
                bind_persons.append(int(age_max))
            except ValueError:
                pass

        # 4. employed
        employed = params.get("employed")
        if employed is not None and employed.lower() in ("true", "false"):
            person_clauses.append("AND p.employed = ?")
            bind_persons.append(employed.lower() == "true")

        # 5. has_license
        has_license = params.get("has_license")
        if has_license is not None and has_license.lower() in ("true", "false"):
            person_clauses.append("AND p.has_driving_license = ?")
            bind_persons.append(has_license.lower() == "true")

        # 6. car_availability
        car_avail = params.get("car_availability")
        if car_avail is not None and car_avail in ("0", "1", "2"):
            person_clauses.append("AND p.car_availability = ?")
            bind_persons.append(float(car_avail))

        # 7. home_canton
        home_canton = params.get("home_canton")
        canton_sql = canton_filter_sql(home_canton, "p.canton_id")
        if canton_sql:
            person_clauses.append(canton_sql)

        # 8. income (requires household join)
        income = params.get("income")
        needs_household_join = False
        if income is not None and income != "":
            try:
                needs_household_join = True
                person_clauses.append("AND h.income = ?")
                bind_persons.append(int(income))
            except ValueError:
                needs_household_join = False

        person_filter = "\n            ".join(person_clauses)

        household_join = ""
        if needs_household_join:
            household_join = (
                "LEFT JOIN households h "
                "ON p.household_id = h.household_id"
            )

        # Time filter (on spider_link_index.departure_time)
        time_clauses: list[str] = []
        bind_time: list = []

        minute_start = params.get("minute_start")
        if minute_start is not None and minute_start != "":
            try:
                time_clauses.append("AND idx.departure_time >= ?")
                bind_time.append(float(int(minute_start) * 60))
            except ValueError:
                pass

        minute_end = params.get("minute_end")
        if minute_end is not None and minute_end != "":
            try:
                time_clauses.append("AND idx.departure_time < ?")
                bind_time.append(float(int(minute_end) * 60))
            except ValueError:
                pass

        time_filter = "\n            ".join(time_clauses)

        return person_filter, household_join, time_filter, bind_persons, bind_time


# ─── 1. Spider Inflow ───────────────────────────────────────────────

class SpiderInflowProvider(_SpiderBase):
    """Links *before* the target — inflow share (0-1).

    Uses the inverted index for fast target-link lookup, then joins
    back to spider_routes for route slicing.

    Example: /data/spider_inflow.json?link_id=868430&sex=1
    """

    ROUTE = "spider_inflow.json"

    def deliver(self, params: dict) -> dict:
        link_id = (params.get("link_id") or "").strip()
        if not link_id:
            return {"error": "link_id parameter is required"}

        person_filter, household_join, time_filter, bind_persons, bind_time = \
            self._build_filters(params)

        con = _get_con()

        query = f"""
            WITH target_trips AS (
                SELECT idx.person_id, idx.trip_index,
                       idx.position AS target_pos
                FROM spider_link_index idx
                INNER JOIN (
                    SELECT CAST(p.person_id AS VARCHAR) AS person_id
                    FROM persons p
                    {household_join}
                    WHERE 1=1
                    {person_filter}
                ) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id = ?
                {time_filter}
            ),
            trip_count AS (
                SELECT COUNT(*) AS total FROM target_trips
            ),
            matched_routes AS (
                SELECT r.route_links, tt.target_pos
                FROM spider_routes r
                INNER JOIN target_trips tt
                    ON r.person_id = tt.person_id
                    AND r.trip_index = tt.trip_index
            ),
            inflow_links AS (
                SELECT UNNEST(route_links[:target_pos - 1]) AS link_id
                FROM matched_routes
                WHERE target_pos > 1
            )
            SELECT il.link_id,
                   ROUND(COUNT(*)::DOUBLE / NULLIF(tc.total, 0), 6) AS share
            FROM inflow_links il, trip_count tc
            GROUP BY il.link_id, tc.total
            ORDER BY share DESC
        """

        bind = bind_persons + [link_id] + bind_time

        try:
            rows = con.execute(query, bind).fetchall()
            total_trips = con.execute(
                f"""
                SELECT COUNT(*)
                FROM spider_link_index idx
                INNER JOIN (
                    SELECT CAST(p.person_id AS VARCHAR) AS person_id
                    FROM persons p
                    {household_join}
                    WHERE 1=1
                    {person_filter}
                ) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id = ?
                {time_filter}
                """,
                bind_persons + [link_id] + bind_time,
            ).fetchone()[0]
        except Exception as e:
            return {"error": str(e)}

        return {
            "target_link": link_id,
            "total_trips": total_trips,
            "links": {row[0]: row[1] for row in rows},
        }


# ─── 2. Spider Outflow ──────────────────────────────────────────────

class SpiderOutflowProvider(_SpiderBase):
    """Links *after* the target — outflow share (0-1).

    Example: /data/spider_outflow.json?link_id=868430
    """

    ROUTE = "spider_outflow.json"

    def deliver(self, params: dict) -> dict:
        link_id = (params.get("link_id") or "").strip()
        if not link_id:
            return {"error": "link_id parameter is required"}

        person_filter, household_join, time_filter, bind_persons, bind_time = \
            self._build_filters(params)

        con = _get_con()

        query = f"""
            WITH target_trips AS (
                SELECT idx.person_id, idx.trip_index,
                       idx.position AS target_pos
                FROM spider_link_index idx
                INNER JOIN (
                    SELECT CAST(p.person_id AS VARCHAR) AS person_id
                    FROM persons p
                    {household_join}
                    WHERE 1=1
                    {person_filter}
                ) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id = ?
                {time_filter}
            ),
            trip_count AS (
                SELECT COUNT(*) AS total FROM target_trips
            ),
            matched_routes AS (
                SELECT r.route_links, tt.target_pos
                FROM spider_routes r
                INNER JOIN target_trips tt
                    ON r.person_id = tt.person_id
                    AND r.trip_index = tt.trip_index
            ),
            outflow_links AS (
                SELECT UNNEST(route_links[target_pos + 1:]) AS link_id
                FROM matched_routes
                WHERE target_pos < len(route_links)
            )
            SELECT ol.link_id,
                   ROUND(COUNT(*)::DOUBLE / NULLIF(tc.total, 0), 6) AS share
            FROM outflow_links ol, trip_count tc
            GROUP BY ol.link_id, tc.total
            ORDER BY share DESC
        """

        bind = bind_persons + [link_id] + bind_time

        try:
            rows = con.execute(query, bind).fetchall()
            total_trips = con.execute(
                f"""
                SELECT COUNT(*)
                FROM spider_link_index idx
                INNER JOIN (
                    SELECT CAST(p.person_id AS VARCHAR) AS person_id
                    FROM persons p
                    {household_join}
                    WHERE 1=1
                    {person_filter}
                ) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id = ?
                {time_filter}
                """,
                bind_persons + [link_id] + bind_time,
            ).fetchone()[0]
        except Exception as e:
            return {"error": str(e)}

        return {
            "target_link": link_id,
            "total_trips": total_trips,
            "links": {row[0]: row[1] for row in rows},
        }


# ─── 3. Spider Overlay ──────────────────────────────────────────────

class SpiderOverlayProvider(_SpiderBase):
    """All links in full routes through target — absolute trip count.

    Uses pure index self-join (no route expansion needed).

    Example: /data/spider_overlay.json?link_id=868430
    """

    ROUTE = "spider_overlay.json"

    def deliver(self, params: dict) -> dict:
        link_id = (params.get("link_id") or "").strip()
        if not link_id:
            return {"error": "link_id parameter is required"}

        person_filter, household_join, time_filter, bind_persons, bind_time = \
            self._build_filters(params)

        con = _get_con()

        query = f"""
            WITH target_trips AS (
                SELECT idx.person_id, idx.trip_index
                FROM spider_link_index idx
                INNER JOIN (
                    SELECT CAST(p.person_id AS VARCHAR) AS person_id
                    FROM persons p
                    {household_join}
                    WHERE 1=1
                    {person_filter}
                ) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id = ?
                {time_filter}
            ),
            overlay AS (
                SELECT idx2.link_id, COUNT(*)::INTEGER AS volume
                FROM spider_link_index idx2
                INNER JOIN target_trips tt
                    ON idx2.person_id = tt.person_id
                    AND idx2.trip_index = tt.trip_index
                GROUP BY idx2.link_id
            )
            SELECT link_id, volume FROM overlay ORDER BY volume DESC
        """

        bind = bind_persons + [link_id] + bind_time

        try:
            rows = con.execute(query, bind).fetchall()
            total_trips = con.execute(
                f"""
                SELECT COUNT(*)
                FROM spider_link_index idx
                INNER JOIN (
                    SELECT CAST(p.person_id AS VARCHAR) AS person_id
                    FROM persons p
                    {household_join}
                    WHERE 1=1
                    {person_filter}
                ) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id = ?
                {time_filter}
                """,
                bind_persons + [link_id] + bind_time,
            ).fetchone()[0]
        except Exception as e:
            return {"error": str(e)}

        return {
            "target_link": link_id,
            "total_trips": total_trips,
            "links": {row[0]: row[1] for row in rows},
        }

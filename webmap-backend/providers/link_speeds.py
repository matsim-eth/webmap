"""Average link speeds — read from the v1 ``link_speeds`` table.

The v1 schema is intentionally lean: ``(link_id, time_bucket, speed)``.
Columns the legacy provider used (volume, road_type, congestion_index,
freespeed, canton_id) are not yet exposed; if the eqasim stage is later
extended to populate them, the queries here only need a small additive
update.

Until then:
  * `avg_speed_kmh`        derived from speed
  * `freespeed_kmh`        looked up from ``network_links.freespeed``
  * `congestion_index`     speed / freespeed
  * `volume`/`road_type`   set to None (data not in v1 schema)
"""

from __future__ import annotations

from .base import DataProvider, Param
from .connection import get_source_cursor


_LINK_SPEED_PARAMS = [
    Param("road_type", "Road type filter (not yet supported in v1 schema)"),
    Param("canton", "Canton name or ID (not yet supported in v1 schema)"),
    Param("polygon_id", "Hot-polygon ID(s), comma-separated (filters by link geometry)"),
    Param("minute_start", "Time window start (minutes from midnight)", param_type="integer"),
    Param("minute_end", "Time window end (minutes from midnight)", param_type="integer"),
]


def _time_clauses(params: dict) -> tuple[str, list]:
    clauses: list[str] = []; bind: list = []
    try:
        if params.get("minute_start") not in (None, ""):
            clauses.append("AND ls.time_bucket >= ?")
            bind.append(int(params["minute_start"]))
    except ValueError:
        pass
    try:
        if params.get("minute_end") not in (None, ""):
            clauses.append("AND ls.time_bucket < ?")
            bind.append(int(params["minute_end"]))
    except ValueError:
        pass
    return " ".join(clauses), bind


def _polygon_clause(params: dict) -> tuple[str, list]:
    pid = (params.get("polygon_id") or "").strip()
    if not pid:
        return "", []
    polygon_ids = [p.strip() for p in pid.split(",") if p.strip()]
    placeholders = ", ".join(["?"] * len(polygon_ids))
    return (
        f"""
        AND EXISTS (
            SELECT 1 FROM hot_polygons hp
            WHERE hp.polygon_id IN ({placeholders})
              AND ST_Intersects(nl.geom, hp.polygon_geom)
        )""",
        polygon_ids,
    )


class LinkSpeedsProvider(DataProvider):
    ROUTE = "link_speeds.json"
    PARAMS = _LINK_SPEED_PARAMS

    def deliver(self, params: dict) -> dict:
        try:
            con = get_source_cursor("synthetic")
        except Exception:
            return {"total_links": 0, "links": {}}
        # Quick check: do we have any link-speed data?
        if con.execute("SELECT COUNT(*) FROM link_speeds").fetchone()[0] == 0:
            return {"total_links": 0, "links": {}, "warning": "link_speeds table is empty"}

        time_sql, time_bind = _time_clauses(params)
        poly_sql, poly_bind = _polygon_clause(params)

        try:
            rows = con.execute(f"""
                SELECT ls.link_id,
                       AVG(ls.speed) * 3.6 AS avg_speed_kmh,
                       AVG(nl.freespeed) * 3.6 AS freespeed_kmh,
                       AVG(ls.speed) / NULLIF(AVG(nl.freespeed), 0) AS congestion_index
                FROM link_speeds ls
                JOIN network_links nl ON ls.link_id = nl.link_id
                WHERE 1=1 {time_sql} {poly_sql}
                GROUP BY ls.link_id
            """, time_bind + poly_bind).fetchall()
        except Exception as e:
            return {"error": str(e)}

        links = {
            r[0]: {
                "road_type": None,
                "avg_speed": round(r[1], 2) if r[1] is not None else None,
                "freespeed": round(r[2], 2) if r[2] is not None else None,
                "congestion_index": round(r[3], 4) if r[3] is not None else None,
                "volume": None,
            }
            for r in rows
        }
        return {"total_links": len(links), "links": links}


class SpeedDashboardProvider(DataProvider):
    ROUTE = "speed_dashboard.json"
    PARAMS = _LINK_SPEED_PARAMS

    def deliver(self, params: dict) -> dict:
        try:
            con = get_source_cursor("synthetic")
        except Exception:
            return self._empty()
        if con.execute("SELECT COUNT(*) FROM link_speeds").fetchone()[0] == 0:
            return {**self._empty(), "warning": "link_speeds table is empty"}

        time_sql, time_bind = _time_clauses(params)

        try:
            rows = con.execute(f"""
                SELECT ls.time_bucket,
                       AVG(ls.speed) * 3.6 AS avg_speed_kmh,
                       AVG(nl.freespeed) * 3.6 AS freespeed_kmh,
                       AVG(ls.speed) / NULLIF(AVG(nl.freespeed), 0) AS congestion_index,
                       COUNT(DISTINCT ls.link_id) AS link_count
                FROM link_speeds ls
                JOIN network_links nl ON ls.link_id = nl.link_id
                WHERE 1=1 {time_sql}
                GROUP BY ls.time_bucket
            """, time_bind).fetchall()
        except Exception as e:
            return {"error": str(e)}

        by_time = [
            {
                "time_bin": int(r[0]) if r[0] is not None else None,
                "avg_speed_kmh": round(r[1], 2) if r[1] is not None else None,
                "freespeed_kmh": round(r[2], 2) if r[2] is not None else None,
                "congestion_index": round(r[3], 4) if r[3] is not None else None,
                "total_volume": None,
                "link_count": int(r[4] or 0),
            }
            for r in rows
        ]

        # Network-wide summary
        sum_row = con.execute(f"""
            SELECT AVG(ls.speed) * 3.6, AVG(nl.freespeed) * 3.6,
                   AVG(ls.speed) / NULLIF(AVG(nl.freespeed), 0),
                   COUNT(DISTINCT ls.link_id)
            FROM link_speeds ls JOIN network_links nl ON ls.link_id = nl.link_id
            WHERE 1=1 {time_sql}
        """, time_bind).fetchone()
        summary = {
            "total_links": int(sum_row[3] or 0),
            "avg_speed_kmh": round(sum_row[0], 2) if sum_row[0] is not None else None,
            "freespeed_kmh": round(sum_row[1], 2) if sum_row[1] is not None else None,
            "congestion_index": round(sum_row[2], 4) if sum_row[2] is not None else None,
            "total_volume": None,
        }
        return {
            "network_summary": summary,
            "by_road_type": [],          # not in v1 schema
            "by_time": by_time,
            "by_time_road_type": [],     # not in v1 schema
        }

    def _empty(self):
        return {
            "network_summary": {"total_links": 0, "avg_speed_kmh": None,
                                "freespeed_kmh": None, "congestion_index": None,
                                "total_volume": 0},
            "by_road_type": [], "by_time": [], "by_time_road_type": [],
        }

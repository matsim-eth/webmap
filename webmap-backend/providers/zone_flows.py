"""Traffic flows between two polygons (link-level volumes).

The polygons can be specified either via legacy canton-name params or via
``origin_polygon_id`` / ``destination_polygon_id`` (any hot polygon).

The flow grid (``flow_grid_500m``) gives us a *count* of trips between
each origin/dest cell pair, which is great for OD-stats but not for the
link-level visualisation. For link volumes we still need to enumerate the
matching trips and join with ``spider_routes`` — but the trip-set is
constrained by R-tree spatial joins on origin_pt/dest_pt, so this stays
fast.
"""

from __future__ import annotations

from .base import DataProvider, Param
from .connection import get_source_cursor
from .constants import CANTON_MAP
from .helpers import resolve_canton_to_polygon_id


_ZONE_FLOWS_PARAMS = [
    Param("origin_canton", "Origin canton name/ID (legacy)"),
    Param("destination_canton", "Destination canton name/ID (legacy)"),
    Param("origin_polygon_id", "Origin hot-polygon ID (e.g. canton:1)"),
    Param("destination_polygon_id", "Destination hot-polygon ID (e.g. canton:2)"),
    Param("direction", "Flow direction", enum=["origin_to_dest", "dest_to_origin", "both"]),
    Param("minute_start", "Time window start (minutes from midnight, 0-1440)", param_type="integer"),
    Param("minute_end", "Time window end (minutes from midnight, 0-1440)", param_type="integer"),
]


def _resolve_polygon_param(params: dict, polygon_key: str, canton_key: str) -> str | None:
    pid = (params.get(polygon_key) or "").strip()
    if pid:
        return pid
    return resolve_canton_to_polygon_id(params.get(canton_key) or "")


class ZoneFlowsProvider(DataProvider):
    """Link-level traffic volumes between two hot-polygons (car trips)."""

    ROUTE = "zone_flows.json"
    PARAMS = _ZONE_FLOWS_PARAMS

    def deliver(self, params: dict) -> dict:
        origin_pid = _resolve_polygon_param(params, "origin_polygon_id", "origin_canton")
        dest_pid = _resolve_polygon_param(params, "destination_polygon_id", "destination_canton")
        if not origin_pid:
            return {"error": "origin_canton or origin_polygon_id is required"}
        if not dest_pid:
            return {"error": "destination_canton or destination_polygon_id is required"}

        direction = (params.get("direction") or "both").strip().lower()
        if direction not in ("origin_to_dest", "dest_to_origin", "both"):
            direction = "both"

        # Time window
        time_clauses: list[str] = []
        try:
            if params.get("minute_start") not in (None, ""):
                time_clauses.append(f"AND t.departure_time >= {int(params['minute_start']) * 60.0}")
        except (TypeError, ValueError):
            pass
        try:
            if params.get("minute_end") not in (None, ""):
                time_clauses.append(f"AND t.departure_time < {int(params['minute_end']) * 60.0}")
        except (TypeError, ValueError):
            pass
        time_filter = " ".join(time_clauses)

        try:
            con = get_source_cursor("synthetic")
        except Exception:
            return {"error": "synthetic dataset not available"}

        # Verify the polygons exist
        meta_rows = con.execute(
            "SELECT polygon_id, polygon_name FROM hot_polygons WHERE polygon_id IN (?, ?)",
            [origin_pid, dest_pid],
        ).fetchall()
        meta = {r[0]: r[1] for r in meta_rows}
        if origin_pid not in meta:
            return {"error": f"unknown polygon: {origin_pid}"}
        if dest_pid not in meta:
            return {"error": f"unknown polygon: {dest_pid}"}

        if direction == "origin_to_dest":
            dir_clause = (
                "ST_Within(t.origin_pt, hp_o.polygon_geom) "
                "AND ST_Within(t.dest_pt, hp_d.polygon_geom)"
            )
        elif direction == "dest_to_origin":
            dir_clause = (
                "ST_Within(t.origin_pt, hp_d.polygon_geom) "
                "AND ST_Within(t.dest_pt, hp_o.polygon_geom)"
            )
        else:  # both
            dir_clause = (
                "( (ST_Within(t.origin_pt, hp_o.polygon_geom) AND ST_Within(t.dest_pt, hp_d.polygon_geom))"
                " OR (ST_Within(t.origin_pt, hp_d.polygon_geom) AND ST_Within(t.dest_pt, hp_o.polygon_geom)) )"
            )

        # Compose query: trips → spider_routes → unnest links
        query = f"""
            WITH hp_o AS (SELECT polygon_geom FROM hot_polygons WHERE polygon_id = ?),
                 hp_d AS (SELECT polygon_geom FROM hot_polygons WHERE polygon_id = ?),
                 matching AS (
                     SELECT t.person_id, t.trip_index
                     FROM trips t, hp_o, hp_d
                     WHERE t.main_mode = 'car'
                       AND {dir_clause}
                       {time_filter}
                 ),
                 routes AS (
                     SELECT r.route_links FROM spider_routes r
                     INNER JOIN matching mt
                       ON r.person_id = mt.person_id
                      AND r.trip_index = mt.trip_index
                 ),
                 links AS (
                     SELECT UNNEST(route_links) AS link_id FROM routes
                 )
            SELECT link_id, COUNT(*)::INTEGER FROM links
            GROUP BY link_id ORDER BY COUNT(*) DESC
        """
        try:
            rows = con.execute(query, [origin_pid, dest_pid]).fetchall()
            total = con.execute(f"""
                WITH hp_o AS (SELECT polygon_geom FROM hot_polygons WHERE polygon_id = ?),
                     hp_d AS (SELECT polygon_geom FROM hot_polygons WHERE polygon_id = ?)
                SELECT COUNT(*) FROM trips t, hp_o, hp_d
                WHERE t.main_mode = 'car' AND {dir_clause}
            """, [origin_pid, dest_pid]).fetchone()[0]
        except Exception as e:
            return {"error": str(e)}

        return {
            "origin_canton": meta.get(origin_pid, origin_pid),
            "destination_canton": meta.get(dest_pid, dest_pid),
            "origin_polygon_id": origin_pid,
            "destination_polygon_id": dest_pid,
            "direction": direction,
            "total_trips": int(total),
            "links": {row[0]: int(row[1]) for row in rows},
        }

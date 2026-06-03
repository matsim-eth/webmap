"""Traffic flows between origin and destination cantons (v2 schema).

Selects car trips that start in one canton and end in another, then returns
the link-level volumes of those trips' routes (car only — only car routes are
stored in ``spider_routes``), grouped by the canton each link passes through.

Uses the precomputed canton columns from the pipeline — ``trips`` has
``origin_canton_id`` / ``dest_canton_id`` and ``network_links`` has
``canton_id`` — so the whole thing is plain integer joins, no spatial work and
no per-dataset cache.

Query params
------------
origin_canton      (str, required)  : Origin canton name or ID.
destination_canton (str, required)  : Destination canton name or ID.
direction          (str)            : "origin_to_dest", "dest_to_origin", or "both" (default).
source             (str)            : Data source (default "synthetic"; only synthetic has routes).
minute_start       (int, 0-1440)    : Time window start (minutes from midnight).
minute_end         (int, 0-1440)    : Time window end (minutes from midnight).
"""

from __future__ import annotations

from .base import DataProvider, Param
from .constants import CANTON_MAP
from .connection import get_source_cursor
from .result_cache import make_cache

_cget, _cput = make_cache(maxsize=48)


_NAME_TO_ID = {v.lower(): k for k, v in CANTON_MAP.items()}


def _resolve_canton(value: str) -> int | None:
    """Resolve a canton name or ID string to a canton ID integer."""
    value = value.strip()
    try:
        cid = int(value)
        if cid in CANTON_MAP:
            return cid
    except ValueError:
        pass
    return _NAME_TO_ID.get(value.lower())


_ZONE_FLOWS_PARAMS = [
    Param("origin_canton", "Origin canton name or ID", required=True),
    Param("destination_canton", "Destination canton name or ID", required=True),
    Param("direction", "Flow direction", enum=["origin_to_dest", "dest_to_origin", "both"]),
    Param("source", "Data source (only synthetic has routes)", enum=["synthetic", "microcensus"]),
    Param("minute_start", "Time window start (minutes from midnight, 0-1440)", param_type="integer"),
    Param("minute_end", "Time window end (minutes from midnight, 0-1440)", param_type="integer"),
]


class ZoneFlowsProvider(DataProvider):
    """Link-level car-traffic volumes for trips between two cantons.

    Example: /data/{id}/zone_flows.json?origin_canton=Zurich&destination_canton=Bern
    """

    ROUTE = "zone_flows.json"
    PARAMS = _ZONE_FLOWS_PARAMS

    def deliver(self, params: dict) -> dict:
        raw_origin = (params.get("origin_canton") or "").strip()
        raw_dest = (params.get("destination_canton") or "").strip()
        if not raw_origin:
            return {"error": "origin_canton parameter is required"}
        if not raw_dest:
            return {"error": "destination_canton parameter is required"}

        origin_id = _resolve_canton(raw_origin)
        dest_id = _resolve_canton(raw_dest)
        if origin_id is None:
            return {"error": f"Unknown canton: {raw_origin}"}
        if dest_id is None:
            return {"error": f"Unknown canton: {raw_dest}"}

        ckey, hit = _cget(self.ROUTE, params)
        if hit is not None:
            return hit

        direction = (params.get("direction") or "both").strip().lower()
        if direction not in ("origin_to_dest", "dest_to_origin", "both"):
            direction = "both"

        if direction == "origin_to_dest":
            pair_clause = "t.origin_canton_id = ? AND t.dest_canton_id = ?"
            pair_bind = [origin_id, dest_id]
        elif direction == "dest_to_origin":
            pair_clause = "t.origin_canton_id = ? AND t.dest_canton_id = ?"
            pair_bind = [dest_id, origin_id]
        else:  # both
            pair_clause = (
                "(t.origin_canton_id = ? AND t.dest_canton_id = ?) OR "
                "(t.origin_canton_id = ? AND t.dest_canton_id = ?)"
            )
            pair_bind = [origin_id, dest_id, dest_id, origin_id]

        # Optional time window on trips.departure_time (seconds from midnight).
        time_clause = ""
        time_bind: list = []
        minute_start = params.get("minute_start")
        if minute_start is not None and minute_start != "":
            try:
                time_bind.append(float(int(minute_start) * 60))
                time_clause += " AND t.departure_time >= ?"
            except ValueError:
                pass
        minute_end = params.get("minute_end")
        if minute_end is not None and minute_end != "":
            try:
                me = int(minute_end)
                if me < 1440:  # full-day slider → no upper cap (include >24:00 trips)
                    time_bind.append(float(me * 60))
                    time_clause += " AND t.departure_time < ?"
            except ValueError:
                pass

        source = (params.get("source") or "synthetic").strip().lower()
        if source not in ("synthetic", "microcensus"):
            source = "synthetic"

        try:
            cur = get_source_cursor(source)
        except Exception as exc:
            return {"error": f"zone_flows data unavailable: {exc}"}

        matching_cte = f"""
            matching_trips AS (
                SELECT t.person_id, t.trip_index
                FROM trips t
                WHERE t.main_mode = 'car'
                  AND ({pair_clause})
                  {time_clause}
            )
        """

        link_query = f"""
            WITH {matching_cte},
            route_links AS (
                SELECT UNNEST(sr.route_links) AS link_id
                FROM spider_routes sr
                JOIN matching_trips mt USING (person_id, trip_index)
            ),
            link_volumes AS (
                SELECT link_id, COUNT(*)::INTEGER AS volume
                FROM route_links GROUP BY link_id
            )
            SELECT nl.canton_id, lv.link_id, lv.volume
            FROM link_volumes lv
            JOIN network_links nl USING (link_id)
            WHERE nl.canton_id IS NOT NULL
            ORDER BY lv.volume DESC
        """
        count_query = f"WITH {matching_cte} SELECT COUNT(*) FROM matching_trips"

        bind = pair_bind + time_bind
        try:
            rows = cur.execute(link_query, bind).fetchall()
            total_trips = cur.execute(count_query, bind).fetchone()[0]
        except Exception as exc:
            return {"error": str(exc)}

        links_by_canton: dict[str, dict] = {}
        for canton_id, link_id, volume in rows:
            if canton_id is None:
                continue
            name = CANTON_MAP.get(canton_id, str(canton_id))
            links_by_canton.setdefault(name, {})[link_id] = volume

        result = {
            "origin_canton": CANTON_MAP.get(origin_id, str(origin_id)),
            "destination_canton": CANTON_MAP.get(dest_id, str(dest_id)),
            "direction": direction,
            "total_trips": total_trips,
            "links_by_canton": links_by_canton,
        }
        _cput(ckey, result)
        return result

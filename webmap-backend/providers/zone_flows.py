"""Traffic flows between origin and destination zones (cantons).

Selects trips that start in one canton and end in another, then returns
the link-level volumes of those trips' routes (car trips only, since
only car routes are stored in spider_routes).

Canton assignment is done at DB build time using point-in-polygon:
each trip's start_x/y and end_x/y coordinates are matched against
canton boundary polygons (TLM_KANTONSGEBIET.geojson).

Query params
------------
origin_canton      (str, required)  : Origin canton name or ID.
destination_canton (str, required)  : Destination canton name or ID.
direction          (str)            : "origin_to_dest", "dest_to_origin", or "both" (default).
minute_start       (int, 0-1440)    : Time window start (minutes from midnight).
minute_end         (int, 0-1440)    : Time window end (minutes from midnight).
"""

from __future__ import annotations

from .base import DataProvider, Param
from .constants import CANTON_MAP
from .spider_analysis import _get_con

# Reverse mapping: canton name → canton ID
_NAME_TO_ID = {v.lower(): k for k, v in CANTON_MAP.items()}


def _resolve_canton(value: str) -> int | None:
    """Resolve a canton name or ID string to a canton ID integer."""
    value = value.strip()
    # Try as integer ID first
    try:
        cid = int(value)
        if cid in CANTON_MAP:
            return cid
    except ValueError:
        pass
    # Try as name (case-insensitive)
    return _NAME_TO_ID.get(value.lower())


_ZONE_FLOWS_PARAMS = [
    Param("origin_canton", "Origin canton name or ID", required=True),
    Param("destination_canton", "Destination canton name or ID", required=True),
    Param("direction", "Flow direction", enum=["origin_to_dest", "dest_to_origin", "both"]),
    Param("minute_start", "Time window start (minutes from midnight, 0-1440)", param_type="integer"),
    Param("minute_end", "Time window end (minutes from midnight, 0-1440)", param_type="integer"),
]


class ZoneFlowsProvider(DataProvider):
    """Link-level traffic volumes for trips between two cantons.

    Uses pre-computed origin_canton_id / dest_canton_id columns on
    output_trips (assigned via spatial join at DB build time).

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

        direction = (params.get("direction") or "both").strip().lower()
        if direction not in ("origin_to_dest", "dest_to_origin", "both"):
            direction = "both"

        # Build direction filter using pre-computed canton columns
        if direction == "origin_to_dest":
            direction_clause = "t.origin_canton_id = ? AND t.dest_canton_id = ?"
            direction_bind = [origin_id, dest_id]
        elif direction == "dest_to_origin":
            direction_clause = "t.origin_canton_id = ? AND t.dest_canton_id = ?"
            direction_bind = [dest_id, origin_id]
        else:  # both
            direction_clause = (
                "(t.origin_canton_id = ? AND t.dest_canton_id = ?) OR "
                "(t.origin_canton_id = ? AND t.dest_canton_id = ?)"
            )
            direction_bind = [origin_id, dest_id, dest_id, origin_id]

        # Time filter
        time_clauses: list[str] = []
        time_bind: list = []

        minute_start = params.get("minute_start")
        if minute_start is not None and minute_start != "":
            try:
                time_clauses.append("AND trip_seconds >= ?")
                time_bind.append(float(int(minute_start) * 60))
            except ValueError:
                pass

        minute_end = params.get("minute_end")
        if minute_end is not None and minute_end != "":
            try:
                time_clauses.append("AND trip_seconds < ?")
                time_bind.append(float(int(minute_end) * 60))
            except ValueError:
                pass

        time_filter = "\n                ".join(time_clauses)

        con = _get_con()

        # Check if required tables exist
        try:
            tables = [r[0] for r in con.execute(
                "SELECT table_name FROM information_schema.tables"
            ).fetchall()]
            if "output_trips" not in tables:
                return {
                    "error": "output_trips table not found. "
                    "Re-run build_spider_db with output_trips_parquet parameter."
                }
        except Exception:
            return {"error": "Could not check database tables"}

        # Check if canton columns exist
        try:
            cols = [r[0] for r in con.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'output_trips'"
            ).fetchall()]
            if "origin_canton_id" not in cols or "dest_canton_id" not in cols:
                return {
                    "error": "Canton columns not found. "
                    "Re-run build_spider_db with canton_geojson parameter."
                }
        except Exception:
            return {"error": "Could not check table columns"}

        # Query: filter trips by canton pair, join with spider_routes for link volumes
        if not time_clauses:
            query = f"""
                WITH matching_trips AS (
                    SELECT
                        t.person,
                        t.trip_number
                    FROM output_trips t
                    WHERE t.main_mode = 'car'
                      AND ({direction_clause})
                ),
                trip_routes AS (
                    SELECT r.route_links
                    FROM spider_routes r
                    INNER JOIN matching_trips mt
                        ON r.person_id = mt.person
                        AND r.trip_index = mt.trip_number - 1
                ),
                all_links AS (
                    SELECT UNNEST(route_links) AS link_id
                    FROM trip_routes
                )
                SELECT link_id, COUNT(*)::INTEGER AS volume
                FROM all_links
                GROUP BY link_id
                ORDER BY volume DESC
            """
        else:
            query = f"""
                WITH trips_with_time AS (
                    SELECT *,
                        CASE
                            WHEN dep_time LIKE '%:%' THEN
                                TRY_CAST(SPLIT_PART(dep_time, ':', 1) AS DOUBLE) * 3600 +
                                TRY_CAST(SPLIT_PART(dep_time, ':', 2) AS DOUBLE) * 60 +
                                TRY_CAST(SPLIT_PART(dep_time, ':', 3) AS DOUBLE)
                            ELSE NULL
                        END AS trip_seconds
                    FROM output_trips
                ),
                matching_trips AS (
                    SELECT
                        t.person,
                        t.trip_number
                    FROM trips_with_time t
                    WHERE t.main_mode = 'car'
                      AND ({direction_clause})
                      {time_filter}
                ),
                trip_routes AS (
                    SELECT r.route_links
                    FROM spider_routes r
                    INNER JOIN matching_trips mt
                        ON r.person_id = mt.person
                        AND r.trip_index = mt.trip_number - 1
                ),
                all_links AS (
                    SELECT UNNEST(route_links) AS link_id
                    FROM trip_routes
                )
                SELECT link_id, COUNT(*)::INTEGER AS volume
                FROM all_links
                GROUP BY link_id
                ORDER BY volume DESC
            """

        bind = direction_bind + time_bind

        try:
            rows = con.execute(query, bind).fetchall()

            # Count total matching trips
            count_query = f"""
                SELECT COUNT(*)
                FROM output_trips t
                WHERE t.main_mode = 'car'
                  AND ({direction_clause})
            """
            total_trips = con.execute(count_query, direction_bind).fetchone()[0]
        except Exception as e:
            return {"error": str(e)}

        return {
            "origin_canton": CANTON_MAP.get(origin_id, str(origin_id)),
            "destination_canton": CANTON_MAP.get(dest_id, str(dest_id)),
            "direction": direction,
            "total_trips": total_trips,
            "links": {row[0]: row[1] for row in rows},
        }

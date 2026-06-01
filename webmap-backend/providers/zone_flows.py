"""Traffic flows between origin and destination cantons (v2 schema).

Selects car trips that start in one canton and end in another, then returns
the link-level volumes of those trips' routes (car only — only car routes are
stored in ``spider_routes``). The result groups links by the canton they pass
through so the frontend knows which canton GeoJSONs to load.

v2 design (reads the per-dataset ``synthetic.duckdb`` directly)
--------------------------------------------------------------
The v1 layout precomputed ``origin_canton_id`` / ``dest_canton_id`` on
``output_trips`` and a link→canton map in ``link_speeds.parquet``. The v2
``synthetic.duckdb`` has neither, so we derive both **once per dataset** and
cache them as TEMP tables on a dedicated read-only connection:

  * ``h3_canton``   — H3-res9 cell → canton_id, built from every cell that
    appears as a trip origin/destination (one representative point per cell,
    point-in-polygon against the 26 ``hot_polygons`` canton geometries).
    Trip→canton matching is then a pure integer hash-join on the H3 index —
    no per-trip spatial op — which scales to millions of trips.
  * ``link_canton`` — link_id → canton_id for the whole network, built from
    link-centroid-in-(simplified)-canton-polygon. The network is fixed-size
    (population-independent), so this is a constant one-time cost (~6 s);
    border links that fall outside the simplified polygons are left
    unassigned and dropped (same behaviour as the legacy unmapped links).

Both tables are population-independent in size; per-request work is integer
joins plus a bounded UNNEST of the matched trips' routes (~0.2 s), keeping
peak memory well within a constrained (32 GB) server.

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

import threading

import duckdb

from .base import DataProvider, Param
from .constants import CANTON_MAP
from .paths import db_path_for_source


# Reverse mapping: canton name → canton ID
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


# ─── Per-dataset helper connection (h3_canton + link_canton cached) ──────────
#
# Keyed by the synthetic.duckdb path. We open a writable **in-memory**
# connection and ``ATTACH`` the dataset read-only as ``syn``. The two derived
# tables are built once (under a lock) as normal tables in the in-memory
# catalog — unlike TEMP tables, normal tables are visible to every
# ``.cursor()`` of the connection, so requests can run concurrently on
# per-thread cursors. Build cost is paid by the first request only and is
# population-independent (both tables scale with geography, not trip count).
_helper_conns: dict[str, duckdb.DuckDBPyConnection] = {}
_helper_lock = threading.Lock()

# Simplification tolerance (metres) for canton polygons used in link→canton
# assignment. Border links are inherently ambiguous, so a coarse boundary is
# fine and makes the one-time build ~7× faster.
_CANTON_SIMPLIFY_M = 50


def _build_helpers(con: duckdb.DuckDBPyConnection) -> None:
    """Build the cached h3_canton and link_canton tables on *con* (which has
    the dataset attached read-only as ``syn``)."""
    try:
        con.execute("LOAD spatial;")
    except Exception:
        con.execute("INSTALL spatial; LOAD spatial;")

    # H3-res9 cell → canton, covering every cell used by a trip origin/dest.
    con.execute(
        """
        CREATE TABLE h3_canton AS
        WITH cells AS (
            SELECT origin_h3_res9 AS h3, ANY_VALUE(origin_pt) AS pt
            FROM syn.trips GROUP BY origin_h3_res9
            UNION ALL
            SELECT dest_h3_res9, ANY_VALUE(dest_pt)
            FROM syn.trips GROUP BY dest_h3_res9
        ),
        uniq AS (SELECT h3, ANY_VALUE(pt) AS pt FROM cells GROUP BY h3)
        SELECT u.h3 AS h3,
               CAST(SPLIT_PART(hp.polygon_id, ':', 2) AS INTEGER) AS canton_id
        FROM uniq u
        JOIN syn.hot_polygons hp
          ON hp.polygon_type = 'canton'
         AND ST_Within(u.pt, hp.polygon_geom)
        """
    )

    # link_id → canton via link-centroid in simplified canton polygon.
    con.execute(
        f"""
        CREATE TABLE link_canton AS
        WITH canton_simpl AS (
            SELECT CAST(SPLIT_PART(polygon_id, ':', 2) AS INTEGER) AS canton_id,
                   ST_Simplify(polygon_geom, {_CANTON_SIMPLIFY_M}) AS g
            FROM syn.hot_polygons WHERE polygon_type = 'canton'
        )
        SELECT nl.link_id, cs.canton_id
        FROM syn.network_links nl
        JOIN canton_simpl cs ON ST_Within(ST_Centroid(nl.geom), cs.g)
        """
    )


def _get_helper_con(source: str) -> duckdb.DuckDBPyConnection:
    """Return the cached helper connection for *source*, building the derived
    tables on first use."""
    db_path = db_path_for_source(source)
    with _helper_lock:
        con = _helper_conns.get(db_path)
        if con is None:
            con = duckdb.connect()  # writable in-memory catalog
            con.execute(f"ATTACH '{db_path}' AS syn (READ_ONLY);")
            _build_helpers(con)
            _helper_conns[db_path] = con
        return con


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

        direction = (params.get("direction") or "both").strip().lower()
        if direction not in ("origin_to_dest", "dest_to_origin", "both"):
            direction = "both"

        # Canton-pair filter on the H3-derived origin/dest canton ids.
        if direction == "origin_to_dest":
            pair_clause = "oc.canton_id = ? AND dc.canton_id = ?"
            pair_bind = [origin_id, dest_id]
        elif direction == "dest_to_origin":
            pair_clause = "oc.canton_id = ? AND dc.canton_id = ?"
            pair_bind = [dest_id, origin_id]
        else:  # both
            pair_clause = (
                "(oc.canton_id = ? AND dc.canton_id = ?) OR "
                "(oc.canton_id = ? AND dc.canton_id = ?)"
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
                # At the slider maximum (full day) leave the window open-ended so
                # MATSim next-day departures (departure_time >= 86400 s, i.e.
                # trips that start after 24:00) are included — otherwise a
                # full-range selection silently drops them.
                if me < 1440:
                    time_bind.append(float(me * 60))
                    time_clause += " AND t.departure_time < ?"
            except ValueError:
                pass

        source = (params.get("source") or "synthetic").strip().lower()
        if source not in ("synthetic", "microcensus"):
            source = "synthetic"

        try:
            cur = _get_helper_con(source).cursor()
        except Exception as exc:
            # The most common cause is a source without a routed network
            # (e.g. microcensus, which has no network_links / spider_routes).
            return {
                "error": "zone_flows requires routed network data, which is only "
                f"available for the 'synthetic' source (source='{source}'): {exc}"
            }

        # Matching car trips between the canton pair (integer H3 joins).
        matching_cte = f"""
            matching_trips AS (
                SELECT t.person_id, t.trip_index
                FROM syn.trips t
                JOIN h3_canton oc ON oc.h3 = t.origin_h3_res9
                JOIN h3_canton dc ON dc.h3 = t.dest_h3_res9
                WHERE t.main_mode = 'car'
                  AND ({pair_clause})
                  {time_clause}
            )
        """

        link_query = f"""
            WITH {matching_cte},
            route_links AS (
                SELECT UNNEST(sr.route_links) AS link_id
                FROM syn.spider_routes sr
                JOIN matching_trips mt USING (person_id, trip_index)
            ),
            link_volumes AS (
                SELECT link_id, COUNT(*)::INTEGER AS volume
                FROM route_links GROUP BY link_id
            )
            SELECT lc.canton_id, lv.link_id, lv.volume
            FROM link_volumes lv
            JOIN link_canton lc USING (link_id)
            ORDER BY lv.volume DESC
        """
        count_query = f"WITH {matching_cte} SELECT COUNT(*) FROM matching_trips"

        bind = pair_bind + time_bind
        try:
            rows = cur.execute(link_query, bind).fetchall()
            total_trips = cur.execute(count_query, bind).fetchone()[0]
        except Exception as exc:
            return {"error": str(exc)}

        # Group links by canton name.
        links_by_canton: dict[str, dict] = {}
        for canton_id, link_id, volume in rows:
            if canton_id is None:
                continue
            name = CANTON_MAP.get(canton_id, str(canton_id))
            links_by_canton.setdefault(name, {})[link_id] = volume

        return {
            "origin_canton": CANTON_MAP.get(origin_id, str(origin_id)),
            "destination_canton": CANTON_MAP.get(dest_id, str(dest_id)),
            "direction": direction,
            "total_trips": total_trips,
            "links_by_canton": links_by_canton,
        }

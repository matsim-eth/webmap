"""Average link speeds from pre-computed link_speeds.parquet.

Provides two endpoints:
  1. link_speeds.json     — per-link speed data (for map visualisation)
  2. speed_dashboard.json — aggregated speed statistics (for dashboard charts)

The parquet file is built by scripts/build_link_speeds from MATSim events +
network XML and contains one row per (link_id, time_bin) combination with
avg_speed, freespeed, congestion_index, volume, road_type, and canton_id.

Query params (both endpoints)
-----------------------------
road_type    (str)  : Filter by road type (comma-separated, e.g. "motorway,primary")
canton       (str)  : Filter by canton name or ID (comma-separated)
minute_start (int)  : Time window start (minutes from midnight, 0-1440)
minute_end   (int)  : Time window end (minutes from midnight, 0-1440)
"""

from __future__ import annotations

import duckdb

from .base import DataProvider, Param
from .constants import CANTON_MAP
from .paths import get_data_paths

_NAME_TO_ID = {v.lower(): k for k, v in CANTON_MAP.items()}

def _get_con() -> duckdb.DuckDBPyConnection:
    """Fresh in-memory connection per request. A shared module-level connection
    would serialize concurrent scans under FastAPI's threadpool, causing proxy-
    side "socket hang up" on overlapping requests (e.g. time slider drag).
    DuckDB caches parquet metadata at the OS/file level, so the cost of opening
    a new connection is minimal."""
    return duckdb.connect(":memory:")


def _resolve_cantons(raw: str) -> list[int]:
    """Parse comma-separated canton names/IDs into a list of canton IDs."""
    ids = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            cid = int(part)
            if cid in CANTON_MAP:
                ids.append(cid)
                continue
        except ValueError:
            pass
        cid = _NAME_TO_ID.get(part.lower())
        if cid is not None:
            ids.append(cid)
    return ids


def _build_filters(params: dict) -> tuple[str, list]:
    """Build SQL WHERE clauses from query params."""
    clauses: list[str] = []
    bind: list = []

    # Road type filter
    road_type = (params.get("road_type") or "").strip()
    if road_type:
        types = [t.strip() for t in road_type.split(",") if t.strip()]
        if types:
            placeholders = ", ".join(["?"] * len(types))
            clauses.append(f"road_type IN ({placeholders})")
            bind.extend(types)

    # Canton filter
    canton = (params.get("canton") or "").strip()
    if canton:
        canton_ids = _resolve_cantons(canton)
        if canton_ids:
            placeholders = ", ".join(["?"] * len(canton_ids))
            clauses.append(f"canton_id IN ({placeholders})")
            bind.extend(canton_ids)

    # Time filter (time_bin is in minutes from midnight)
    minute_start = params.get("minute_start")
    if minute_start is not None and minute_start != "":
        try:
            ms = int(minute_start)
            # Round down to nearest time bin
            clauses.append("time_bin >= ?")
            bind.append(ms - (ms % 15))
        except ValueError:
            pass

    minute_end = params.get("minute_end")
    if minute_end is not None and minute_end != "":
        try:
            me = int(minute_end)
            clauses.append("time_bin < ?")
            bind.append(me)
        except ValueError:
            pass

    where = " AND ".join(clauses) if clauses else "1=1"
    return where, bind


_LINK_SPEED_PARAMS = [
    Param("road_type", "Road type filter (comma-separated, e.g. motorway,primary)"),
    Param("canton", "Canton name or ID (comma-separated)"),
    Param("minute_start", "Time window start (minutes from midnight)", param_type="integer"),
    Param("minute_end", "Time window end (minutes from midnight)", param_type="integer"),
]


class LinkSpeedsProvider(DataProvider):
    """Per-link average speeds for map visualisation.

    Returns a dict of link_id → {avg_speed, freespeed, congestion_index, volume}
    for all links matching the filters.  Speeds are averaged across the
    selected time bins.

    Example: /data/{id}/link_speeds.json?road_type=motorway&canton=Zurich
    """

    ROUTE = "link_speeds.json"
    PARAMS = _LINK_SPEED_PARAMS

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        parquet = paths.link_speeds

        where, bind = _build_filters(params)

        try:
            con = _get_con()
            rows = con.execute(f"""
                SELECT
                    link_id,
                    ANY_VALUE(road_type)              AS road_type,
                    ROUND(SUM(avg_speed * volume) / SUM(volume) * 3.6, 2)
                        AS avg_speed_kmh,
                    ROUND(AVG(freespeed) * 3.6, 2)  AS freespeed_kmh,
                    ROUND(SUM(avg_speed * volume) / SUM(volume)
                          / AVG(freespeed), 4)       AS congestion_index,
                    SUM(volume)::INTEGER              AS volume
                FROM read_parquet('{parquet}')
                WHERE {where}
                GROUP BY link_id
                ORDER BY volume DESC
            """, bind).fetchall()
        except Exception as e:
            return {"error": str(e)}

        links = {}
        for r in rows:
            links[r[0]] = {
                "road_type": r[1],
                "avg_speed": r[2],
                "freespeed": r[3],
                "congestion_index": r[4],
                "volume": r[5],
            }

        return {
            "total_links": len(links),
            "links": links,
        }


class SpeedDashboardProvider(DataProvider):
    """Aggregated speed statistics for the dashboard.

    Returns:
      - by_road_type: average speed, freespeed, congestion index per road type
      - by_time: average speed and congestion index per 15-min time bin
      - network_summary: overall network averages

    Example: /data/{id}/speed_dashboard.json?canton=Zurich
    """

    ROUTE = "speed_dashboard.json"
    PARAMS = _LINK_SPEED_PARAMS

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        parquet = paths.link_speeds

        where, bind = _build_filters(params)

        try:
            con = _get_con()
            # Single scan: GROUPING SETS returns all four aggregations at once.
            # Row-level: sum weighted numerators + volume; derive kmh/congestion in Python.
            # link_count is computed only for the road_type and total grouping sets
            # (COUNT DISTINCT is expensive and not needed for time-based rows).
            rows = con.execute(f"""
                SELECT
                    GROUPING(time_bin)   AS g_time,
                    GROUPING(road_type)  AS g_rt,
                    time_bin,
                    road_type,
                    SUM(avg_speed * volume) AS speed_num,
                    SUM(freespeed * volume) AS free_num,
                    SUM(volume)             AS vol,
                    CASE WHEN GROUPING(time_bin) = 1
                         THEN COUNT(DISTINCT link_id) END AS link_count
                FROM read_parquet('{parquet}')
                WHERE {where}
                GROUP BY GROUPING SETS (
                    (time_bin, road_type),
                    (road_type),
                    (time_bin),
                    ()
                )
            """, bind).fetchall()
        except Exception as e:
            return {"error": str(e)}

        def kmh(num, vol):
            if not vol:
                return None
            return round(num / vol * 3.6, 2)

        def cong(speed_num, free_num):
            if not speed_num or not free_num:
                return None
            return round(speed_num / free_num, 4)

        by_road_type = []
        by_time = []
        by_time_road_type = []
        summary = None

        for g_time, g_rt, time_bin, road_type, speed_num, free_num, vol, link_count in rows:
            vol_int = int(vol) if vol is not None else 0
            if g_time == 0 and g_rt == 0:
                by_time_road_type.append({
                    "time_bin": time_bin,
                    "road_type": road_type,
                    "avg_speed_kmh": kmh(speed_num, vol),
                    "congestion_index": cong(speed_num, free_num),
                    "total_volume": vol_int,
                })
            elif g_time == 1 and g_rt == 0:
                by_road_type.append({
                    "road_type": road_type,
                    "link_count": int(link_count) if link_count is not None else 0,
                    "avg_speed_kmh": kmh(speed_num, vol),
                    "freespeed_kmh": kmh(free_num, vol),
                    "congestion_index": cong(speed_num, free_num),
                    "total_volume": vol_int,
                })
            elif g_time == 0 and g_rt == 1:
                by_time.append({
                    "time_bin": time_bin,
                    "avg_speed_kmh": kmh(speed_num, vol),
                    "congestion_index": cong(speed_num, free_num),
                    "total_volume": vol_int,
                })
            else:
                summary = {
                    "total_links": int(link_count) if link_count is not None else 0,
                    "avg_speed_kmh": kmh(speed_num, vol),
                    "freespeed_kmh": kmh(free_num, vol),
                    "congestion_index": cong(speed_num, free_num),
                    "total_volume": vol_int,
                }

        by_road_type.sort(key=lambda r: r["total_volume"], reverse=True)
        by_time.sort(key=lambda r: r["time_bin"] or 0)
        by_time_road_type.sort(key=lambda r: (r["time_bin"] or 0, r["road_type"] or ""))

        return {
            "network_summary": summary or {
                "total_links": 0,
                "avg_speed_kmh": None,
                "freespeed_kmh": None,
                "congestion_index": None,
                "total_volume": 0,
            },
            "by_road_type": by_road_type,
            "by_time": by_time,
            "by_time_road_type": by_time_road_type,
        }

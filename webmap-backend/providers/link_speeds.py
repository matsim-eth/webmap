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
            con = duckdb.connect(":memory:")
            rows = con.execute(f"""
                SELECT
                    link_id,
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
            con.close()
        except Exception as e:
            return {"error": str(e)}

        links = {}
        for r in rows:
            links[r[0]] = {
                "avg_speed": r[1],
                "freespeed": r[2],
                "congestion_index": r[3],
                "volume": r[4],
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
            con = duckdb.connect(":memory:")

            # 1. By road type
            road_type_rows = con.execute(f"""
                SELECT
                    road_type,
                    COUNT(DISTINCT link_id)::INTEGER AS link_count,
                    ROUND(SUM(avg_speed * volume) / SUM(volume) * 3.6, 2)
                        AS avg_speed_kmh,
                    ROUND(SUM(freespeed * volume) / SUM(volume) * 3.6, 2)
                        AS freespeed_kmh,
                    ROUND(SUM(avg_speed * volume) / SUM(volume)
                          / (SUM(freespeed * volume) / SUM(volume)), 4)
                        AS congestion_index,
                    SUM(volume)::INTEGER AS total_volume
                FROM read_parquet('{parquet}')
                WHERE {where}
                GROUP BY road_type
                ORDER BY total_volume DESC
            """, bind).fetchall()

            # 2. By time bin
            time_rows = con.execute(f"""
                SELECT
                    time_bin,
                    ROUND(SUM(avg_speed * volume) / SUM(volume) * 3.6, 2)
                        AS avg_speed_kmh,
                    ROUND(SUM(avg_speed * volume) / SUM(volume)
                          / (SUM(freespeed * volume) / SUM(volume)), 4)
                        AS congestion_index,
                    SUM(volume)::INTEGER AS total_volume
                FROM read_parquet('{parquet}')
                WHERE {where}
                GROUP BY time_bin
                ORDER BY time_bin
            """, bind).fetchall()

            # 3. Network summary
            summary = con.execute(f"""
                SELECT
                    COUNT(DISTINCT link_id)::INTEGER AS total_links,
                    ROUND(SUM(avg_speed * volume) / SUM(volume) * 3.6, 2)
                        AS avg_speed_kmh,
                    ROUND(SUM(freespeed * volume) / SUM(volume) * 3.6, 2)
                        AS freespeed_kmh,
                    ROUND(SUM(avg_speed * volume) / SUM(volume)
                          / (SUM(freespeed * volume) / SUM(volume)), 4)
                        AS congestion_index,
                    SUM(volume)::INTEGER AS total_volume
                FROM read_parquet('{parquet}')
                WHERE {where}
            """, bind).fetchone()

            con.close()
        except Exception as e:
            return {"error": str(e)}

        return {
            "network_summary": {
                "total_links": summary[0],
                "avg_speed_kmh": summary[1],
                "freespeed_kmh": summary[2],
                "congestion_index": summary[3],
                "total_volume": summary[4],
            },
            "by_road_type": [
                {
                    "road_type": r[0],
                    "link_count": r[1],
                    "avg_speed_kmh": r[2],
                    "freespeed_kmh": r[3],
                    "congestion_index": r[4],
                    "total_volume": r[5],
                }
                for r in road_type_rows
            ],
            "by_time": [
                {
                    "time_bin": r[0],
                    "avg_speed_kmh": r[1],
                    "congestion_index": r[2],
                    "total_volume": r[3],
                }
                for r in time_rows
            ],
        }

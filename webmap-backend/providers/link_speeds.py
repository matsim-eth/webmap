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

from collections import OrderedDict

from .base import DataProvider, Param
from .connection import get_source_cursor
from .paths import dataset_key
from .zone_registry import get_registry, zone_col

# ─── Result cache ──────────────────────────────────────────────────────────
# link_speeds.json (per canton/time-window) and speed_dashboard.json scan the
# 50M-row link_speeds table; cold that is tens of seconds. The dataset is
# read-only so a given (dataset, params) always yields the same result — cache
# it. Bounded LRU keeps memory in check (link_speeds responses are ~20 MB each).
_RESULT_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_CACHE_MAX = 24


def _cache_get(route: str, params: dict):
    key = (route, dataset_key(),
           tuple(sorted((k, str(v)) for k, v in params.items() if v not in (None, ""))))
    hit = _RESULT_CACHE.get(key)
    if hit is not None:
        _RESULT_CACHE.move_to_end(key)
    return key, hit


def _cache_put(key: tuple, value: dict) -> None:
    # Don't cache error responses — let the next request retry.
    if isinstance(value, dict) and set(value.keys()) == {"error"}:
        return
    _RESULT_CACHE[key] = value
    _RESULT_CACHE.move_to_end(key)
    while len(_RESULT_CACHE) > _CACHE_MAX:
        _RESULT_CACHE.popitem(last=False)

def _get_con():
    """Pooled read-only cursor on synthetic.duckdb (where the link_speeds table
    now lives — v2 stores speeds as a table, not a parquet file)."""
    return get_source_cursor("synthetic")


def _resolve_cantons(raw: str) -> list[int]:
    """Parse comma-separated zone names/IDs into a list of zone IDs, resolved
    through the dataset's zone registry."""
    reg = get_registry()
    ids = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        zid = reg.resolve_zone(part)
        if zid is not None:
            ids.append(zid)
    return ids


def _build_filters(params: dict) -> tuple[str, list]:
    """Build SQL WHERE clauses from query params."""
    # Exclude abstract links with non-finite freespeed (MATSim sets freespeed to
    # infinity on teleport/abstract links); they would poison the weighted sums.
    clauses: list[str] = ["isfinite(freespeed)"]
    bind: list = []

    # Road type filter
    road_type = (params.get("road_type") or "").strip()
    if road_type:
        types = [t.strip() for t in road_type.split(",") if t.strip()]
        if types:
            placeholders = ", ".join(["?"] * len(types))
            clauses.append(f"road_type IN ({placeholders})")
            bind.extend(types)

    # Canton/zone filter
    canton = (params.get("canton") or params.get("zone") or "").strip()
    if canton:
        canton_ids = _resolve_cantons(canton)
        if canton_ids:
            zcol = zone_col("synthetic", "link_speeds", "zone")
            placeholders = ", ".join(["?"] * len(canton_ids))
            clauses.append(f"{zcol} IN ({placeholders})")
            bind.extend(canton_ids)

    # Time filter. The v2 `time_bin` column is a 15-minute bin INDEX (0..95);
    # query params are minutes-from-midnight, so convert minutes → bin index.
    minute_start = params.get("minute_start")
    if minute_start is not None and minute_start != "":
        try:
            clauses.append("time_bin >= ?")
            bind.append(int(minute_start) // 15)
        except ValueError:
            pass

    minute_end = params.get("minute_end")
    if minute_end is not None and minute_end != "":
        try:
            clauses.append("time_bin < ?")
            bind.append((int(minute_end) + 14) // 15)
        except ValueError:
            pass

    where = " AND ".join(clauses) if clauses else "1=1"
    return where, bind


# ─── Per-link hourly traffic volumes (road "Volumes" module) ────────────────
# Backend replacement for the old preprocessed CDN asset
# `matsim/{canton}_link_traffic_volumes.json`. Derived from the same
# link_speeds.volume column the speed endpoints use (volume = count of car
# "entered link" events per directed link per 15-min bin).
#
# Result cache keyed by (dataset, canton). Each canton's result is a large
# Python list (Zurich ~116k links → ~100 MB in memory), so the cache is a
# small bounded LRU — repeat loads of the same canton are instant without an
# unbounded leak across all 26 cantons × every dataset a worker touches.
_TRAFFIC_CACHE: "OrderedDict[tuple, list]" = OrderedDict()
_TRAFFIC_CACHE_MAX = 6


# Hierarchy classes counted as "major roads" — the server-side twin of the
# frontend's MAJOR_ROADS_FILTER (components/map/_lib/mapboxFilters.js). The
# `_link` variants keep motorway/primary/secondary ramps attached.
MAJOR_ROAD_TYPES = (
    "motorway", "motorway_link",
    "primary", "primary_link",
    "secondary", "secondary_link",
)


def major_road_clause(alias: str = "") -> tuple[str, list]:
    """SQL predicate for "major road", plus its bind parameters.

    The exact twin of the frontend's ``MAJOR_ROADS_FILTER``: hierarchy class
    when the link carries a usable ``road_type``, else the legacy
    ``capacity > 1200`` threshold for untagged links.

    Shared by the per-link volumes and by the network geometry subset so the two
    can never disagree — a geometry subset narrower than the map filter would
    silently drop links the user expects to see.

    ``alias`` qualifies the columns (e.g. ``"nl"``); omit it for an unaliased
    ``FROM network_links``.
    """
    p = f"{alias}." if alias else ""
    placeholders = ", ".join("?" * len(MAJOR_ROAD_TYPES))
    clause = (
        f"({p}road_type IN ({placeholders}) "
        f"OR (({p}road_type IS NULL OR {p}road_type IN ('unknown', '')) "
        f"AND {p}capacity > 1200))"
    )
    return clause, list(MAJOR_ROAD_TYPES)


def link_traffic_volumes(
    canton_id: int, min_capacity: float | None = None, major: bool = False
) -> list:
    """Per-link hourly car traffic volumes for a canton.

    Returns ``[{link_id, hourly_avg_volumes}]`` where ``hourly_avg_volumes`` is
    a 24-element array indexed by hour of day. Matches the shape the road
    "Volumes" module (``useNetworkLayers``) expects: it looks each directed
    ``link_id`` up by the segment's ``per_id_keys`` and splits left/right by the
    per-link arrow. Links with no traffic are simply absent (→ treated as 0).

    ``major`` restricts the result to major roads by hierarchy — the same
    predicate the frontend's "major roads only" map filter (MAJOR_ROADS_FILTER)
    applies: ``road_type`` in MAJOR_ROAD_TYPES, falling back to the legacy
    ``capacity > 1200`` threshold for untagged links (road_type NULL/'unknown').
    ``min_capacity`` is the older pure-capacity variant, kept for backward
    compatibility. The default Volumes view is major-only, so requesting just
    those links cuts the payload ~10× (the rest is fetched lazily when the
    toggle is switched off). Cached per (dataset, canton, filter variant).
    """
    ckey = (dataset_key(), canton_id, min_capacity, major)
    cached = _TRAFFIC_CACHE.get(ckey)
    if cached is not None:
        _TRAFFIC_CACHE.move_to_end(ckey)
        return cached

    con = _get_con()
    zcol = zone_col("synthetic", "link_speeds", "zone")
    # time_bin is a 15-min bin index (0..95); // 4 → hour (0..23). A flat
    # GROUP BY + Python dict fill is the fastest build measured — packing the
    # 24-array in SQL (ordered list_agg) or via numpy.unique on the string
    # link_ids were both slower.
    rows = None
    if major or min_capacity is not None:
        if major:
            link_clause, major_args = major_road_clause("nl")
            args = [canton_id, *major_args]
        else:
            link_clause = "nl.capacity > ?"
            args = [canton_id, min_capacity]
        try:
            rows = con.execute(
                f"""
                SELECT ls.link_id, ls.time_bin // 4 AS hour, SUM(ls.volume)::INTEGER AS volume
                FROM link_speeds ls
                JOIN network_links nl
                  ON CAST(nl.link_id AS VARCHAR) = CAST(ls.link_id AS VARCHAR)
                WHERE ls.{zcol} = ? AND {link_clause}
                GROUP BY ls.link_id, ls.time_bin // 4
                """,
                args,
            ).fetchall()
        except Exception:
            # Older dataset without a network_links table → fall back to the full
            # (unfiltered) scan; the frontend still filters the map to major roads.
            rows = None
    if rows is None:
        rows = con.execute(
            f"""
            SELECT link_id, time_bin // 4 AS hour, SUM(volume)::INTEGER AS volume
            FROM link_speeds
            WHERE {zcol} = ?
            GROUP BY link_id, time_bin // 4
            """,
            [canton_id],
        ).fetchall()

    by_link: dict[str, list[int]] = {}
    for link_id, hour, volume in rows:
        arr = by_link.get(link_id)
        if arr is None:
            arr = [0] * 24
            by_link[link_id] = arr
        if 0 <= hour < 24:
            arr[hour] = volume

    result = [
        {"link_id": lid, "hourly_avg_volumes": arr}
        for lid, arr in by_link.items()
    ]
    _TRAFFIC_CACHE[ckey] = result
    _TRAFFIC_CACHE.move_to_end(ckey)
    while len(_TRAFFIC_CACHE) > _TRAFFIC_CACHE_MAX:
        _TRAFFIC_CACHE.popitem(last=False)
    return result


_LINK_SPEED_PARAMS = [
    Param("road_type", "Road type filter (comma-separated, e.g. motorway,primary)"),
    Param("canton", "Canton name or ID (comma-separated)"),
    Param("zone", "Zone name or ID (comma-separated); alias of canton"),
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
        ckey, hit = _cache_get(self.ROUTE, params)
        if hit is not None:
            return hit
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
                FROM link_speeds
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

        result = {
            "total_links": len(links),
            "links": links,
        }
        _cache_put(ckey, result)
        return result


class LinkVolumesProvider(DataProvider):
    """Per-link total daily volume (vehicles) for a canton, summed across time
    bins from the link_speeds table. Used by the VolumeFlow module to hide links
    that carry no traffic — the old merged-network asset baked a `daily_avg_volume`
    attribute per link, but the v2 per-link geometry asset doesn't, so the
    frontend computes it from this endpoint instead. Only links with volume > 0
    are returned (absent link → 0 trips → hidden).

    Example: /data/{id}/link_volumes.json?canton=Zurich
    """

    ROUTE = "link_volumes.json"
    PARAMS = _LINK_SPEED_PARAMS

    def deliver(self, params: dict) -> dict:
        ckey, hit = _cache_get(self.ROUTE, params)
        if hit is not None:
            return hit
        where, bind = _build_filters(params)

        try:
            con = _get_con()
            rows = con.execute(f"""
                SELECT link_id, SUM(volume)::INTEGER AS volume
                FROM link_speeds
                WHERE {where}
                GROUP BY link_id
                HAVING SUM(volume) > 0
            """, bind).fetchall()
        except Exception as e:
            return {"error": str(e)}

        result = {"total_links": len(rows), "links": {r[0]: r[1] for r in rows}}
        _cache_put(ckey, result)
        return result


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
        ckey, hit = _cache_get(self.ROUTE, params)
        if hit is not None:
            return hit
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
                FROM link_speeds
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
                    "time_bin": time_bin * 15,  # bin index → minutes from midnight
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
                    "time_bin": time_bin * 15,  # bin index → minutes from midnight
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

        result = {
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
        _cache_put(ckey, result)
        return result

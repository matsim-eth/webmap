"""Polygon trip summary — counts of trips that start, end, or are contained
within a user-drawn polygon, broken down by main mode.

Categories:
  - outbound: start inside polygon, end outside
  - inbound:  start outside polygon, end inside
  - internal: both endpoints inside the polygon

Coordinate system: the polygon is supplied in WGS84 (lng/lat). Trip endpoints
in the duckdb `trips` table are already stored as GEOMETRY in CH1903+/LV95
(EPSG:2056); the spatial extension reprojects the polygon once per request.

Query params
------------
polygon       (str, required) : One or more polygon rings as
                                "lng,lat;lng,lat;...", multiple rings joined
                                with "|". Rings are auto-closed and unioned
                                into a single study area.
minute_start  (int, 0-1440)   : Departure time window start (minutes from midnight).
minute_end    (int, 0-1440)   : Departure time window end (minutes from midnight).
source        (str)           : "synthetic" (default) or "microcensus".
"""

from __future__ import annotations

from .base import DataProvider, Param
from .connection import get_source_cursor
from .result_cache import make_cache

_cget, _cput = make_cache(maxsize=48)


def _parse_polygon(raw: str) -> str | None:
    """Convert one or more rings into a WGS84 MULTIPOLYGON WKT, or None on bad input.

    Rings are separated by "|", points within a ring by ";", coords by ",".
    A single ring (no "|") yields a one-part multipolygon so the format stays
    backward compatible with the old single-polygon wire encoding. All drawn
    polygons are unioned into one study area, so a trip whose endpoints fall in
    two different rings counts as "internal".
    """
    if not raw:
        return None
    rings_wkt: list[str] = []
    for ring_raw in raw.split("|"):
        pts: list[tuple[float, float]] = []
        for chunk in ring_raw.split(";"):
            chunk = chunk.strip()
            if not chunk:
                continue
            try:
                lng_s, lat_s = chunk.split(",", 1)
                lng = float(lng_s)
                lat = float(lat_s)
            except (ValueError, IndexError):
                return None
            pts.append((lng, lat))
        if not pts:
            # empty segment (e.g. a trailing "|") — skip
            continue
        if len(pts) < 3:
            return None
        if pts[0] != pts[-1]:
            pts.append(pts[0])
        inner = ", ".join(f"{lng} {lat}" for lng, lat in pts)
        rings_wkt.append(f"(({inner}))")
    if not rings_wkt:
        return None
    return f"MULTIPOLYGON({', '.join(rings_wkt)})"


_PARAMS = [
    Param("polygon", "One or more rings 'lng,lat;lng,lat;...' joined by '|' (WGS84); rings are unioned", required=True),
    Param("minute_start", "Departure window start (minutes from midnight)", param_type="integer"),
    Param("minute_end", "Departure window end (minutes from midnight)", param_type="integer"),
    Param("source", "'synthetic' (default) or 'microcensus'"),
]


class PolygonTripsProvider(DataProvider):
    """Mode-broken-down trip counts for a user-drawn polygon.

    Example: /data/{id}/polygon_trips.json?polygon=8.5,47.35;8.6,47.35;8.6,47.4;8.5,47.4
    """

    ROUTE = "polygon_trips.json"
    PARAMS = _PARAMS

    def deliver(self, params: dict) -> dict:
        wkt = _parse_polygon(params.get("polygon") or "")
        if not wkt:
            return {"error": "polygon parameter is required as 'lng,lat;lng,lat;...' with at least 3 points"}

        source = (params.get("source") or "synthetic").lower()
        if source in ("syn",):
            source = "synthetic"
        if source in ("mc",):
            source = "microcensus"
        if source not in ("synthetic", "microcensus"):
            return {"error": f"unknown source: {source!r}"}

        ckey, hit = _cget(self.ROUTE, params)
        if hit is not None:
            return hit

        # Optional departure-time window. `trips.departure_time` is DOUBLE
        # seconds-from-midnight in the new duckdb schema.
        time_clauses: list[str] = []
        time_bind: list = []
        for key, op in (("minute_start", ">="), ("minute_end", "<")):
            v = params.get(key)
            if v is not None and v != "":
                try:
                    time_clauses.append(f"AND departure_time {op} ?")
                    time_bind.append(float(int(v) * 60))
                except ValueError:
                    pass
        time_filter = "\n            ".join(time_clauses)

        cur = get_source_cursor(source)

        # Bounding-box pre-filter via ST_X/ST_Y narrows ~99% of trips out
        # before ST_Within runs. Without it the full ST_Within scan is ~slow
        # at ~300k rows; with it the query is sub-second.
        query = f"""
            WITH poly AS (
                SELECT ST_Transform(ST_GeomFromText(?),
                                    'EPSG:4326', 'EPSG:2056',
                                    always_xy := true) AS geom
            ),
            poly_bbox AS (
                SELECT geom,
                       ST_XMin(geom) AS xmin, ST_XMax(geom) AS xmax,
                       ST_YMin(geom) AS ymin, ST_YMax(geom) AS ymax
                FROM poly
            ),
            trips_in_bbox AS (
                SELECT main_mode,
                       ST_X(origin_pt) AS ox, ST_Y(origin_pt) AS oy,
                       ST_X(dest_pt)   AS dx, ST_Y(dest_pt)   AS dy,
                       origin_pt, dest_pt
                FROM trips
                WHERE 1=1
                {time_filter}
            ),
            classified AS (
                SELECT main_mode,
                    CASE WHEN ox BETWEEN p.xmin AND p.xmax
                          AND oy BETWEEN p.ymin AND p.ymax
                         THEN ST_Within(origin_pt, p.geom)
                         ELSE FALSE END AS start_in,
                    CASE WHEN dx BETWEEN p.xmin AND p.xmax
                          AND dy BETWEEN p.ymin AND p.ymax
                         THEN ST_Within(dest_pt, p.geom)
                         ELSE FALSE END AS end_in
                FROM trips_in_bbox t, poly_bbox p
            )
            SELECT main_mode,
                   SUM(CASE WHEN start_in AND NOT end_in THEN 1 ELSE 0 END)::INTEGER AS outbound,
                   SUM(CASE WHEN NOT start_in AND end_in THEN 1 ELSE 0 END)::INTEGER AS inbound,
                   SUM(CASE WHEN start_in AND end_in     THEN 1 ELSE 0 END)::INTEGER AS internal
            FROM classified
            WHERE start_in OR end_in
            GROUP BY main_mode
            ORDER BY main_mode
        """
        bind = [wkt] + time_bind

        try:
            rows = cur.execute(query, bind).fetchall()
        except Exception as e:
            return {"error": str(e)}

        by_mode: dict[str, dict[str, int]] = {}
        totals = {"outbound": 0, "inbound": 0, "internal": 0}
        for mode, outbound, inbound, internal in rows:
            by_mode[mode or "unknown"] = {
                "outbound": int(outbound or 0),
                "inbound": int(inbound or 0),
                "internal": int(internal or 0),
            }
            totals["outbound"] += int(outbound or 0)
            totals["inbound"] += int(inbound or 0)
            totals["internal"] += int(internal or 0)

        result = {
            "totals": totals,
            "total_trips": totals["outbound"] + totals["inbound"] + totals["internal"],
            "by_mode": by_mode,
        }
        _cput(ckey, result)
        return result

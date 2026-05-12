"""Polygon trip summary — counts of trips that start, end, or are contained
within a user-drawn polygon, broken down by main mode.

Categories:
  - outbound: start inside polygon, end outside
  - inbound:  start outside polygon, end inside
  - internal: both endpoints inside the polygon

Coordinate system: the polygon is supplied in WGS84 (lng/lat), trip endpoints
are stored in CH1903+/LV95 (EPSG:2056). DuckDB's spatial extension reprojects
the polygon once per request.

Query params
------------
polygon       (str, required) : Polygon ring as "lng,lat;lng,lat;..." (closed
                                or open — the ring is auto-closed).
minute_start  (int, 0-1440)   : Departure time window start (minutes from midnight).
minute_end    (int, 0-1440)   : Departure time window end (minutes from midnight).
"""

from __future__ import annotations

import threading

import duckdb

from .base import DataProvider, Param
from .paths import get_data_paths


# ─── Per-dataset DuckDB connections (in-memory, spatial loaded) ────────

_connections: dict[str, duckdb.DuckDBPyConnection] = {}
_connections_lock = threading.Lock()


def _get_con(parquet_path: str) -> duckdb.DuckDBPyConnection:
    """Return a thread-safe cursor on a connection with spatial loaded."""
    with _connections_lock:
        if parquet_path not in _connections:
            con = duckdb.connect()
            con.execute("INSTALL spatial; LOAD spatial;")
            con.execute("SET memory_limit = '4GB'")
            _connections[parquet_path] = con
        return _connections[parquet_path].cursor()


# ─── Helpers ──────────────────────────────────────────────────────────

def _parse_polygon(raw: str) -> str | None:
    """Convert "lng,lat;lng,lat;..." into a WGS84 POLYGON WKT, or None on bad input."""
    if not raw:
        return None
    pts: list[tuple[float, float]] = []
    for chunk in raw.split(";"):
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
    if len(pts) < 3:
        return None
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    inner = ", ".join(f"{lng} {lat}" for lng, lat in pts)
    return f"POLYGON(({inner}))"


# ─── Provider ─────────────────────────────────────────────────────────

_PARAMS = [
    Param("polygon", "Polygon ring as 'lng,lat;lng,lat;...' (WGS84)", required=True),
    Param("minute_start", "Departure window start (minutes from midnight)", param_type="integer"),
    Param("minute_end", "Departure window end (minutes from midnight)", param_type="integer"),
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

        # Optional time window on dep_time (string "HH:MM:SS" in output_trips.parquet)
        time_clauses: list[str] = []
        time_bind: list = []
        for key, op in (("minute_start", ">="), ("minute_end", "<")):
            v = params.get(key)
            if v is not None and v != "":
                try:
                    time_clauses.append(f"AND trip_seconds {op} ?")
                    time_bind.append(float(int(v) * 60))
                except ValueError:
                    pass
        time_filter = "\n            ".join(time_clauses)

        parquet_path = get_data_paths().synthetic_output_trips
        con = _get_con(parquet_path)

        # Bounding-box pre-filter pushes ~99% of rows out before ST_Within runs.
        # Without it the query takes ~13s; with it ~0.3s on 297k trips.
        if time_filter:
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
                trips_with_time AS (
                    SELECT *,
                        CASE WHEN dep_time LIKE '%:%' THEN
                            TRY_CAST(SPLIT_PART(dep_time, ':', 1) AS DOUBLE) * 3600 +
                            TRY_CAST(SPLIT_PART(dep_time, ':', 2) AS DOUBLE) * 60 +
                            TRY_CAST(SPLIT_PART(dep_time, ':', 3) AS DOUBLE)
                        ELSE NULL END AS trip_seconds
                    FROM read_parquet(?)
                ),
                classified AS (
                    SELECT main_mode,
                        CASE WHEN start_x BETWEEN p.xmin AND p.xmax
                              AND start_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(start_x, start_y), p.geom)
                             ELSE FALSE END AS start_in,
                        CASE WHEN end_x BETWEEN p.xmin AND p.xmax
                              AND end_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(end_x, end_y), p.geom)
                             ELSE FALSE END AS end_in
                    FROM trips_with_time t, poly_bbox p
                    WHERE 1=1
                    {time_filter}
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
            bind = [wkt, parquet_path] + time_bind
        else:
            query = """
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
                classified AS (
                    SELECT main_mode,
                        CASE WHEN start_x BETWEEN p.xmin AND p.xmax
                              AND start_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(start_x, start_y), p.geom)
                             ELSE FALSE END AS start_in,
                        CASE WHEN end_x BETWEEN p.xmin AND p.xmax
                              AND end_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(end_x, end_y), p.geom)
                             ELSE FALSE END AS end_in
                    FROM read_parquet(?) t, poly_bbox p
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
            bind = [wkt, parquet_path]

        try:
            rows = con.execute(query, bind).fetchall()
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

        return {
            "totals": totals,
            "total_trips": totals["outbound"] + totals["inbound"] + totals["internal"],
            "by_mode": by_mode,
        }

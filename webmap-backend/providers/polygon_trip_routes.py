"""Route-level link volumes for trips intersecting a user-drawn polygon,
split into the same three categories as polygon_trips.json:

  - outbound: start inside polygon, end outside
  - inbound:  start outside polygon, end inside
  - internal: both endpoints inside the polygon

Only car trips are returned because spider_routes only stores car routes.

Coordinates: polygon is supplied in WGS84 (lng/lat); the spider DB's
output_trips table stores LV95 (EPSG:2056) start/end coordinates. The
spatial extension reprojects the polygon once per request.

Query params
------------
polygon       (str, required) : Polygon ring as "lng,lat;lng,lat;...".
minute_start  (int, 0-1440)   : Departure window start (minutes from midnight).
minute_end    (int, 0-1440)   : Departure window end (minutes from midnight).
"""

from __future__ import annotations

from pathlib import Path

from .base import DataProvider, Param
from .constants import CANTON_MAP
from .paths import get_data_paths
from .polygon_trips import _parse_polygon
from .spider_analysis import _get_con


_PARAMS = [
    Param("polygon", "Polygon ring as 'lng,lat;lng,lat;...' (WGS84)", required=True),
    Param("minute_start", "Departure window start (minutes from midnight)", param_type="integer"),
    Param("minute_end", "Departure window end (minutes from midnight)", param_type="integer"),
]


class PolygonTripRoutesProvider(DataProvider):
    """Per-category car route volumes for a drawn polygon.

    Example: /data/{id}/polygon_trip_routes.json?polygon=8.5,47.35;8.6,47.35;...
    """

    ROUTE = "polygon_trip_routes.json"
    PARAMS = _PARAMS

    def deliver(self, params: dict) -> dict:
        wkt = _parse_polygon(params.get("polygon") or "")
        if not wkt:
            return {"error": "polygon parameter is required as 'lng,lat;lng,lat;...' with at least 3 points"}

        # Optional dep_time window (string "HH:MM:SS")
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

        link_speeds_path = get_data_paths().link_speeds
        if not Path(link_speeds_path).exists():
            return {
                "error": "link_speeds.parquet not found. "
                "Re-run build_link_speeds with canton_geojson parameter."
            }

        con = _get_con()
        # Spatial extension is preinstalled in the image; LOAD is idempotent.
        con.execute("LOAD spatial;")

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
                    FROM output_trips
                    WHERE main_mode = 'car'
                ),
                classified AS (
                    SELECT t.person, t.trip_number,
                        CASE WHEN start_x BETWEEN p.xmin AND p.xmax
                              AND start_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(start_x, start_y), p.geom)
                             ELSE FALSE END AS s_in,
                        CASE WHEN end_x BETWEEN p.xmin AND p.xmax
                              AND end_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(end_x, end_y), p.geom)
                             ELSE FALSE END AS e_in
                    FROM trips_with_time t, poly_bbox p
                    WHERE 1=1
                    {time_filter}
                ),
                filtered AS (
                    SELECT person, trip_number,
                        CASE WHEN s_in AND NOT e_in THEN 'outbound'
                             WHEN NOT s_in AND e_in THEN 'inbound'
                             WHEN s_in AND e_in     THEN 'internal'
                        END AS category
                    FROM classified WHERE s_in OR e_in
                ),
                trip_routes AS (
                    SELECT f.category, r.route_links
                    FROM spider_routes r
                    INNER JOIN filtered f
                        ON r.person_id = f.person
                        AND r.trip_index = f.trip_number - 1
                ),
                all_links AS (
                    SELECT category, UNNEST(route_links) AS link_id
                    FROM trip_routes
                ),
                link_canton AS (
                    SELECT DISTINCT link_id, canton_id
                    FROM read_parquet(?) WHERE canton_id IS NOT NULL
                )
                SELECT a.category, a.link_id, lc.canton_id, COUNT(*)::INTEGER AS volume
                FROM all_links a
                LEFT JOIN link_canton lc ON a.link_id = lc.link_id
                GROUP BY a.category, a.link_id, lc.canton_id
            """
            bind = [wkt] + time_bind + [link_speeds_path]
            count_query = f"""
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
                    FROM output_trips
                    WHERE main_mode = 'car'
                )
                SELECT
                    SUM(CASE WHEN s_in AND NOT e_in THEN 1 ELSE 0 END)::INTEGER,
                    SUM(CASE WHEN NOT s_in AND e_in THEN 1 ELSE 0 END)::INTEGER,
                    SUM(CASE WHEN s_in AND e_in     THEN 1 ELSE 0 END)::INTEGER
                FROM (
                    SELECT
                        CASE WHEN start_x BETWEEN p.xmin AND p.xmax
                              AND start_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(start_x, start_y), p.geom)
                             ELSE FALSE END AS s_in,
                        CASE WHEN end_x BETWEEN p.xmin AND p.xmax
                              AND end_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(end_x, end_y), p.geom)
                             ELSE FALSE END AS e_in
                    FROM trips_with_time t, poly_bbox p
                    WHERE 1=1
                    {time_filter}
                )
                WHERE s_in OR e_in
            """
            count_bind = [wkt] + time_bind
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
                    SELECT t.person, t.trip_number,
                        CASE WHEN start_x BETWEEN p.xmin AND p.xmax
                              AND start_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(start_x, start_y), p.geom)
                             ELSE FALSE END AS s_in,
                        CASE WHEN end_x BETWEEN p.xmin AND p.xmax
                              AND end_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(end_x, end_y), p.geom)
                             ELSE FALSE END AS e_in
                    FROM output_trips t, poly_bbox p
                    WHERE t.main_mode = 'car'
                ),
                filtered AS (
                    SELECT person, trip_number,
                        CASE WHEN s_in AND NOT e_in THEN 'outbound'
                             WHEN NOT s_in AND e_in THEN 'inbound'
                             WHEN s_in AND e_in     THEN 'internal'
                        END AS category
                    FROM classified WHERE s_in OR e_in
                ),
                trip_routes AS (
                    SELECT f.category, r.route_links
                    FROM spider_routes r
                    INNER JOIN filtered f
                        ON r.person_id = f.person
                        AND r.trip_index = f.trip_number - 1
                ),
                all_links AS (
                    SELECT category, UNNEST(route_links) AS link_id
                    FROM trip_routes
                ),
                link_canton AS (
                    SELECT DISTINCT link_id, canton_id
                    FROM read_parquet(?) WHERE canton_id IS NOT NULL
                )
                SELECT a.category, a.link_id, lc.canton_id, COUNT(*)::INTEGER AS volume
                FROM all_links a
                LEFT JOIN link_canton lc ON a.link_id = lc.link_id
                GROUP BY a.category, a.link_id, lc.canton_id
            """
            bind = [wkt, link_speeds_path]
            count_query = """
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
                )
                SELECT
                    SUM(CASE WHEN s_in AND NOT e_in THEN 1 ELSE 0 END)::INTEGER,
                    SUM(CASE WHEN NOT s_in AND e_in THEN 1 ELSE 0 END)::INTEGER,
                    SUM(CASE WHEN s_in AND e_in     THEN 1 ELSE 0 END)::INTEGER
                FROM (
                    SELECT
                        CASE WHEN start_x BETWEEN p.xmin AND p.xmax
                              AND start_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(start_x, start_y), p.geom)
                             ELSE FALSE END AS s_in,
                        CASE WHEN end_x BETWEEN p.xmin AND p.xmax
                              AND end_y BETWEEN p.ymin AND p.ymax
                             THEN ST_Within(ST_Point(end_x, end_y), p.geom)
                             ELSE FALSE END AS e_in
                    FROM output_trips t, poly_bbox p
                    WHERE t.main_mode = 'car'
                )
                WHERE s_in OR e_in
            """
            count_bind = [wkt]

        try:
            rows = con.execute(query, bind).fetchall()
            counts = con.execute(count_query, count_bind).fetchone() or (0, 0, 0)
        except Exception as e:
            return {"error": str(e)}

        routes_by_category: dict[str, dict[str, dict[str, int]]] = {
            "outbound": {},
            "inbound": {},
            "internal": {},
        }
        for category, link_id, canton_id, volume in rows:
            if canton_id is None or category not in routes_by_category:
                continue
            canton_name = CANTON_MAP.get(canton_id, str(canton_id))
            bucket = routes_by_category[category].setdefault(canton_name, {})
            bucket[link_id] = volume

        return {
            "category_totals": {
                "outbound": int(counts[0] or 0),
                "inbound":  int(counts[1] or 0),
                "internal": int(counts[2] or 0),
            },
            "total_car_trips": int((counts[0] or 0) + (counts[1] or 0) + (counts[2] or 0)),
            "routes_by_category": routes_by_category,
        }

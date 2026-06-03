"""Per-canton node GeoJSON, generated from the duckdb ``network_nodes`` table.

Uses the precomputed ``network_nodes.canton_id`` column (from the pipeline) to
select the nodes of a canton directly, reprojects them from LV95 (EPSG:2056) to
WGS84, and returns a GeoJSON ``FeatureCollection`` — each feature has
``properties.id = node_id``. The assembled collection is cached per
(dataset, canton). No spatial join / cache build at request time.

The companion ``node_flows.json`` endpoint computes the flow numbers at a node.
Only ``node_id`` + position are available; richer node metadata would need
extra columns on ``network_nodes`` from the pipeline.
"""

from __future__ import annotations

import threading

from fastapi.responses import JSONResponse

from .base import DataProvider, Param
from .connection import get_source_cursor
from .helpers import resolve_canton_to_polygon_id


_COORD_DECIMALS = 6  # ~0.1 m; keeps the payload small
_fc_cache: dict[tuple[str, int], dict] = {}
_lock = threading.Lock()


def _canton_id_from_param(canton: str) -> int | None:
    pid = resolve_canton_to_polygon_id(canton)
    if not pid:
        return None
    try:
        return int(pid.split(":", 1)[1])
    except (ValueError, IndexError):
        return None


class NodesGeoJSONProvider(DataProvider):
    """Return node points for a canton as a WGS84 GeoJSON FeatureCollection.

    Example: /data/{dataset_id}/nodes_geojson.json?canton=Zurich
    """

    ROUTE = "nodes_geojson.json"
    PARAMS = [
        Param("canton", "Canton name or ID (e.g. Zurich)", required=True),
    ]

    def deliver(self, params: dict):
        canton = (params.get("canton") or "").strip()
        if not canton:
            return {"error": "canton parameter is required"}
        cid = _canton_id_from_param(canton)
        if cid is None:
            return {"error": f"Unknown canton: {canton}"}

        cache_key = ("synthetic", cid)
        with _lock:
            cached = _fc_cache.get(cache_key)
            if cached is not None:
                return JSONResponse(cached)
            try:
                cur = get_source_cursor("synthetic")
                rows = cur.execute(
                    f"""
                    SELECT node_id,
                           ROUND(ST_X(p), {_COORD_DECIMALS}) AS lng,
                           ROUND(ST_Y(p), {_COORD_DECIMALS}) AS lat
                    FROM (
                        SELECT node_id,
                               ST_Transform(geom, 'EPSG:2056', 'EPSG:4326', always_xy := true) AS p
                        FROM network_nodes
                        WHERE canton_id = ?
                    )
                    """,
                    [cid],
                ).fetchall()
            except Exception as exc:
                return {"error": f"nodes unavailable: {exc}"}

            fc = {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"id": node_id},
                        "geometry": {"type": "Point", "coordinates": [lng, lat]},
                    }
                    for node_id, lng, lat in rows
                ],
            }
            _fc_cache[cache_key] = fc
            return JSONResponse(fc)

"""Serve node-points within a polygon as a GeoJSON FeatureCollection.

Reads ``network_nodes`` from synthetic.duckdb and (optionally) clips to a
hot-polygon (``polygon_id``) or a canton (legacy ``canton`` param).
"""

from __future__ import annotations

from .base import DataProvider, Param
from .connection import get_source_cursor
from .helpers import resolve_canton_to_polygon_id


class NodesGeoJSONProvider(DataProvider):
    ROUTE = "nodes_geojson.json"
    PARAMS = [
        Param("canton", "Canton name or ID (legacy)"),
        Param("polygon_id", "Hot-polygon ID (e.g., canton:1, gemeinde:261)"),
    ]

    def deliver(self, params: dict) -> dict:
        polygon_id = (params.get("polygon_id") or "").strip()
        if not polygon_id:
            polygon_id = resolve_canton_to_polygon_id(params.get("canton") or "")
        if not polygon_id:
            return {"error": "canton or polygon_id parameter is required"}

        try:
            con = get_source_cursor("synthetic")
        except Exception:
            return {"error": "synthetic dataset not available"}

        # Verify polygon exists
        meta = con.execute(
            "SELECT polygon_id FROM hot_polygons WHERE polygon_id = ?",
            [polygon_id],
        ).fetchone()
        if not meta:
            return {"error": f"unknown polygon: {polygon_id}"}

        rows = con.execute("""
            SELECT n.node_id, ST_AsGeoJSON(n.geom)
            FROM network_nodes n
            JOIN hot_polygons hp ON hp.polygon_id = ?
              AND ST_Within(n.geom, hp.polygon_geom)
        """, [polygon_id]).fetchall()

        import json
        features = []
        for node_id, geom_json in rows:
            try:
                geom = json.loads(geom_json) if isinstance(geom_json, str) else geom_json
            except Exception:
                continue
            features.append({
                "type": "Feature",
                "properties": {"node_id": node_id},
                "geometry": geom,
            })
        return {"type": "FeatureCollection", "features": features}

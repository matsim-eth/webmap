"""Serve per-canton node GeoJSON from pre-built static files.

Reads ``<root>/synthetic/nodes_by_canton/{canton}_nodes.geojson`` straight
from disk. This is much cheaper than recomputing from ``network_nodes`` at
request time (the duckdb version had to ST_Within ~840k nodes against the
canton polygon on every cold call) and matches the property shape the
webmap's Node Flows module expects (each feature has ``properties.id``
plus the original swisstopo node metadata).

The companion ``node_flows.json`` endpoint still queries the duckdb tables
for the actual flow numbers at a node.
"""

from __future__ import annotations

import json
from pathlib import Path

from .base import DataProvider, Param
from .paths import get_data_paths


class NodesGeoJSONProvider(DataProvider):
    """Return node points for a canton.

    Example: /data/{dataset_id}/nodes_geojson.json?canton=Zurich
    """

    ROUTE = "nodes_geojson.json"
    PARAMS = [
        Param("canton", "Canton name (e.g. Zurich)", required=True),
    ]

    def deliver(self, params: dict) -> dict:
        canton = (params.get("canton") or "").strip()
        if not canton:
            return {"error": "canton parameter is required"}

        nodes_path = Path(get_data_paths().root) / "synthetic" / "nodes_by_canton" / f"{canton}_nodes.geojson"
        if not nodes_path.exists():
            return {"error": f"Nodes file not found for canton {canton}"}

        with open(nodes_path, "r", encoding="utf-8") as f:
            return json.load(f)

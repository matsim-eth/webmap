"""Serve per-canton node GeoJSON from the synthetic directory."""

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

        paths = get_data_paths()
        # synthetic dir is parent of the parquet files
        synthetic_dir = Path(paths.synthetic_persons).parent
        nodes_path = synthetic_dir / "nodes_by_canton" / f"{canton}_nodes.geojson"

        if not nodes_path.exists():
            return {"error": f"Nodes file not found for canton {canton}"}

        with open(nodes_path, "r", encoding="utf-8") as f:
            return json.load(f)

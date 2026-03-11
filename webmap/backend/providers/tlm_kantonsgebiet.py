"""TLM Kantonsgebiet data in GeoJSON or JSON format.

Consolidates the former 2 endpoints into 1:
  TLM_KANTONSGEBIET.geojson -> ?format=geojson
  TLM_KANTONSGEBIET.json    -> ?format=json

Query params
------------
format      (str): "geojson" (default) or "json".
canton      (str): Comma-separated canton IDs (KANTONSNUMMER) to include.
canton_name (str): Comma-separated canton names to include.
simplify    (str): "true" to remove geometry coordinates (lighter payload).
"""

import json
import os

from .base import DataProvider
from .constants import CANTON_MAP
from .paths import get_data_paths

_NAME_TO_ID = {v: k for k, v in CANTON_MAP.items()}

# Cache loaded data per format
_CACHE: dict[str, dict | list] = {}


def _load(fmt: str):
    if fmt not in _CACHE:
        paths = get_data_paths()
        if fmt == "json":
            filepath = os.path.join(paths.json_preview_dir, "TLM_KANTONSGEBIET.json")
        else:
            filepath = os.path.join(paths.json_preview_dir, "TLM_KANTONSGEBIET.geojson")
        with open(filepath, "r") as f:
            _CACHE[fmt] = json.load(f)
    return _CACHE[fmt]


def _filter_features(data, params: dict):
    canton_ids = None
    canton_names = None
    simplify = params.get("simplify", "").lower() == "true"

    if params.get("canton"):
        try:
            canton_ids = {int(c.strip()) for c in params["canton"].split(",")}
        except ValueError:
            canton_ids = None

    if params.get("canton_name"):
        canton_names = {c.strip() for c in params["canton_name"].split(",")}

    needs_filter = canton_ids is not None or canton_names is not None

    if not needs_filter and not simplify:
        return data

    if isinstance(data, dict) and "features" in data:
        filtered_features = []
        for feature in data["features"]:
            props = feature.get("properties", {})
            if needs_filter:
                k_num = props.get("KANTONSNUMMER")
                k_name = props.get("NAME")
                match = False
                if canton_ids is not None and k_num is not None:
                    try:
                        if int(k_num) in canton_ids:
                            match = True
                    except (ValueError, TypeError):
                        pass
                if canton_names is not None and k_name is not None:
                    if str(k_name) in canton_names:
                        match = True
                if not match:
                    continue

            if simplify:
                feature = dict(feature)
                feature.pop("geometry", None)

            filtered_features.append(feature)

        result = dict(data)
        result["features"] = filtered_features
        return result

    return data


class TlmKantonsgebietProvider(DataProvider):
    ROUTE = "tlm_kantonsgebiet.json"

    def deliver(self, params: dict) -> dict | list:
        fmt = params.get("format", "geojson").lower()
        if fmt not in ("geojson", "json"):
            fmt = "geojson"
        data = _load(fmt)
        return _filter_features(data, params)

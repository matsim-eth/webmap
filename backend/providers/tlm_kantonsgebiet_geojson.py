import json
import os

from .base import DataProvider
from .constants import CANTON_MAP
from .paths import get_data_paths

_NAME_TO_ID = {v: k for k, v in CANTON_MAP.items()}


class TlmKantonsgebietGeojsonProvider(DataProvider):
    """TLM Kantonsgebiet data in GeoJSON format, loaded from static file.

    Query params:
        canton      (str): Comma-separated canton IDs (KANTONSNUMMER) to include.
        canton_name (str): Comma-separated canton names to include.
        simplify    (str): "true" to remove geometry coordinates (lighter payload).

    Example: /data/TLM_KANTONSGEBIET.geojson?canton_name=Zurich,Bern
    """

    ROUTE = "TLM_KANTONSGEBIET.geojson"
    _data: dict | None = None

    def _load(self) -> dict:
        if TlmKantonsgebietGeojsonProvider._data is None:
            paths = get_data_paths()
            filepath = os.path.join(paths.json_preview_dir, "TLM_KANTONSGEBIET.geojson")
            with open(filepath, "r") as f:
                TlmKantonsgebietGeojsonProvider._data = json.load(f)
        return TlmKantonsgebietGeojsonProvider._data

    def deliver(self, params: dict) -> dict:
        data = self._load()

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

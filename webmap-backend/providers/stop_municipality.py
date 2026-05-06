import json
import os

from .base import DataProvider, Param
from .paths import get_data_paths


_cache: dict[str, dict] = {}


class StopMunicipalityProvider(DataProvider):
    """Per-dataset stop_id → municipality lookup, precomputed offline.

    Built by webmap-backend/scripts/build_municipalities (point-in-polygon
    of every stop against the simplified Swiss municipalities polygons).

    The frontend uses this to aggregate stop-level boardings/alightings
    into per-municipality totals for the Transit Lines dashboard.

    Query params:
        cantons (str): Comma-separated canton names. When present, only stops
            whose `kanton` field matches one in the list are returned. Cuts
            the response from ~10 MB to <1 MB per canton.
    """

    ROUTE = "stop_municipality.json"
    PARAMS = [
        Param("cantons", "Comma-separated canton names to filter by"),
    ]

    def _load(self) -> dict:
        paths = get_data_paths()
        cache_key = paths.json_preview_dir
        if cache_key in _cache:
            return _cache[cache_key]

        filepath = os.path.join(paths.json_preview_dir, "stop_municipality.json")
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        _cache[cache_key] = data
        return data

    def deliver(self, params: dict) -> dict:
        data = self._load()

        cantons_param = params.get("cantons")
        if not cantons_param:
            return data

        wanted = {c.strip() for c in cantons_param.split(",") if c.strip()}
        if not wanted:
            return data

        return {sid: info for sid, info in data.items() if info.get("kanton") in wanted}

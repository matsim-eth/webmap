from .base import DataProvider, Param
from .constants import canton_name
from .helpers import load_static_asset
from .paths import dataset_key


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
        dk = dataset_key()
        if dk in _cache:
            return _cache[dk]
        raw = load_static_asset("synthetic", "stop_municipality")
        if raw is None:
            raise FileNotFoundError("stop_municipality not in static_assets")
        # Field mapping for the frontend: it keys on `bfs_nummer`, `municipality`
        # and `kanton` (name); the v2 asset uses `bfs`, `gemeinde`, `canton_id`.
        data = {
            sid: {
                **info,
                "kanton": canton_name(info["canton_id"]) if info.get("canton_id") is not None else None,
                "bfs_nummer": info.get("bfs"),
                "municipality": info.get("gemeinde"),
            }
            for sid, info in raw.items()
        }
        _cache[dk] = data
        return data

    def deliver(self, params: dict) -> dict:
        try:
            data = self._load()
        except FileNotFoundError:
            return {"error": "stop_municipality.json not available in this dataset "
                             "(json_preview assets were not built)"}

        cantons_param = params.get("cantons")
        if not cantons_param:
            return data

        wanted = {c.strip() for c in cantons_param.split(",") if c.strip()}
        if not wanted:
            return data

        return {sid: info for sid, info in data.items() if info.get("kanton") in wanted}

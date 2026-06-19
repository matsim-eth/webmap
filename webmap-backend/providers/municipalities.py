from .base import DataProvider, Param
from .helpers import load_static_asset
from .paths import dataset_key


_cache: dict[str, dict] = {}


# FSO canton numbering — matches the `kantonsnum` field set by
# build_municipalities.py.
_CANTON_NAME_TO_NUM = {
    "Zurich": 1, "Bern": 2, "Luzern": 3, "Uri": 4, "Schwyz": 5, "Obwalden": 6,
    "Nidwalden": 7, "Glarus": 8, "Zug": 9, "Fribourg": 10, "Solothurn": 11,
    "Basel-Stadt": 12, "Basel-Landschaft": 13, "Schaffhausen": 14,
    "AppenzellAusserrhoden": 15, "AppenzellInnerrhoden": 16, "StGallen": 17,
    "Graubunden": 18, "Aargau": 19, "Thurgau": 20, "Ticino": 21, "Vaud": 22,
    "Valais": 23, "Neuchatel": 24, "Geneve": 25, "Jura": 26,
}


class MunicipalitiesProvider(DataProvider):
    """Reprojected + simplified Swiss municipalities polygons (WGS84).

    Built once by webmap-backend/scripts/build_municipalities. Used by the
    Transit Lines dashboard to outline municipalities the selected line
    crosses.

    Query params:
        cantons (str): Comma-separated canton names (e.g. "Zurich,Bern"). When
            present, only features whose `kantonsnum` matches a canton in the
            list are returned. Cuts the response from ~26 MB to ~1–3 MB per
            canton, which is the dominant cost on the Transit Lines tab.
    """

    ROUTE = "municipalities.geojson"
    PARAMS = [
        Param("cantons", "Comma-separated canton names to filter by"),
    ]

    def _load(self) -> dict:
        dk = dataset_key()
        if dk in _cache:
            return _cache[dk]
        data = load_static_asset("synthetic", "municipalities")
        if data is None:
            raise FileNotFoundError("municipalities not in static_assets")
        # Field mapping for the frontend: CantonMap filters the selected line's
        # municipalities by `bfs_nummer`, but the v2 asset stores the BFS number
        # under `bfs`. Mirror StopMunicipalityProvider's rename so both transit
        # assets expose `bfs_nummer` consistently.
        for feat in data.get("features") or []:
            props = feat.get("properties")
            if props is not None and "bfs_nummer" not in props:
                props["bfs_nummer"] = props.get("bfs")
        _cache[dk] = data
        return data

    def deliver(self, params: dict) -> dict:
        try:
            data = self._load()
        except FileNotFoundError:
            return {"error": "municipalities.geojson not available in this dataset "
                             "(json_preview assets were not built)"}

        cantons_param = params.get("cantons")
        if not cantons_param:
            return data

        wanted_nums = set()
        for name in cantons_param.split(","):
            name = name.strip()
            if not name:
                continue
            num = _CANTON_NAME_TO_NUM.get(name)
            if num is not None:
                wanted_nums.add(num)
        if not wanted_nums:
            return data

        features = data.get("features") or []
        filtered = [
            f for f in features
            if (f.get("properties") or {}).get("kantonsnum") in wanted_nums
        ]
        return {"type": "FeatureCollection", "features": filtered}

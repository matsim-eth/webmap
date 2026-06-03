from collections import defaultdict

from .base import DataProvider, Param
from .constants import canton_name
from .helpers import load_static_asset
from .paths import dataset_key


# Per-dataset cache, keyed by dataset root.
_transfer_cache: dict[str, dict] = {}


class StopTransferDataProvider(DataProvider):
    """Stop transfer data by canton, loaded from static JSON and filtered.

    Top-level keys are canton names. Each canton contains stop data that can
    be filtered by minimum boardings, minimum transfers, or specific stop IDs.

    Query params:
        canton        (str): Comma-separated canton names to include.
        min_boardings (int): Only include stops with at least this many boardings.
        min_transfers (int): Only include stops with at least this many transfers.
        stop_id       (str): Comma-separated stop IDs to include.

    Example: /data/stop_transfer_data_by_canton.json?canton=Zurich&min_boardings=100
    """

    ROUTE = "stop_transfer_data_by_canton.json"
    PARAMS = [
        Param("canton", "Comma-separated canton names to include"),
        Param("min_boardings", "Only include stops with at least this many boardings", param_type="integer"),
        Param("min_transfers", "Only include stops with at least this many transfers", param_type="integer"),
        Param("stop_id", "Comma-separated stop IDs to include"),
    ]
    def _load(self) -> dict:
        """Transform the v2 static_asset (list of
        ``{canton_id, total_transfers, stops:[{stop_id, name, bfs, transfers}]}``)
        into the canton-name-keyed dict the frontend expects, adding per-stop
        ``boardings`` (summed from boarding_data, since the transfer asset only
        carries transfers)."""
        dk = dataset_key()
        if dk in _transfer_cache:
            return _transfer_cache[dk]
        raw = load_static_asset("synthetic", "stop_transfer_data_by_canton")
        if raw is None:
            raise FileNotFoundError("stop_transfer_data not in static_assets")

        # per-stop total boardings from boarding_data_by_line
        boardings_by_stop: dict[str, int] = defaultdict(int)
        boarding = load_static_asset("synthetic", "boarding_data_by_line") or []
        for line in boarding:
            for stop in line.get("stops", []):
                sid = stop.get("stop_id")
                for d in stop.get("data", []):
                    boardings_by_stop[sid] += d.get("boardings", 0)

        out: dict[str, list] = {}
        for entry in raw:
            cname = canton_name(entry.get("canton_id"))
            stops = []
            for s in entry.get("stops", []):
                sid = s.get("stop_id")
                stops.append({**s, "boardings": int(boardings_by_stop.get(sid, 0))})
            out[cname] = stops
        _transfer_cache[dk] = out
        return out

    def deliver(self, params: dict) -> dict:
        try:
            data = self._load()
        except FileNotFoundError:
            return {"error": "stop_transfer_data_by_canton.json not available in this dataset "
                             "(json_preview assets were not built)"}

        canton_param = params.get("canton")
        min_boardings = None
        min_transfers = None
        stop_ids = None

        if params.get("min_boardings"):
            try:
                min_boardings = int(params["min_boardings"])
            except ValueError:
                pass

        if params.get("min_transfers"):
            try:
                min_transfers = int(params["min_transfers"])
            except ValueError:
                pass

        if params.get("stop_id"):
            stop_ids = {s.strip() for s in params["stop_id"].split(",")}

        # Filter by canton (top-level keys)
        if canton_param:
            cantons = {c.strip() for c in canton_param.split(",")}
            filtered_data = {k: v for k, v in data.items() if k in cantons}
        else:
            filtered_data = dict(data)

        # Filter stops within each canton
        if min_boardings is not None or min_transfers is not None or stop_ids is not None:
            result = {}
            for canton_key, stops in filtered_data.items():
                if not isinstance(stops, list):
                    result[canton_key] = stops
                    continue

                filtered_stops = []
                for stop in stops:
                    if not isinstance(stop, dict):
                        filtered_stops.append(stop)
                        continue

                    if stop_ids is not None:
                        sid = str(stop.get("stop_id", ""))
                        if sid not in stop_ids:
                            continue

                    if min_boardings is not None:
                        boardings = stop.get("boardings", 0)
                        if isinstance(boardings, (int, float)) and boardings < min_boardings:
                            continue

                    if min_transfers is not None:
                        transfers = stop.get("transfers", 0)
                        if isinstance(transfers, (int, float)) and transfers < min_transfers:
                            continue

                    filtered_stops.append(stop)

                result[canton_key] = filtered_stops
            return result

        return filtered_data

import json
import os

from .base import DataProvider
from .paths import get_data_paths


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
    _data: dict | None = None

    def _load(self) -> dict:
        if StopTransferDataProvider._data is None:
            paths = get_data_paths()
            filepath = os.path.join(paths.json_preview_dir, "stop_transfer_data_by_canton.json")
            with open(filepath, "r") as f:
                StopTransferDataProvider._data = json.load(f)
        return StopTransferDataProvider._data

    def deliver(self, params: dict) -> dict:
        data = self._load()

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

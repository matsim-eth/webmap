"""Stop transfer data — served from the ``static_assets`` BLOB table."""

from __future__ import annotations

import json

from .base import DataProvider, Param
from .connection import default_source, get_source_cursor


_KEY = "stop_transfer_data_by_canton"


class StopTransferDataProvider(DataProvider):
    ROUTE = "stop_transfer_data_by_canton.json"
    PARAMS = [
        Param("canton", "Comma-separated canton names to include"),
        Param("min_boardings", "Only include stops with at least this many boardings", param_type="integer"),
        Param("min_transfers", "Only include stops with at least this many transfers", param_type="integer"),
        Param("stop_id", "Comma-separated stop IDs to include"),
    ]

    def deliver(self, params: dict) -> dict:
        src = default_source()
        if not src:
            return {}
        try:
            con = get_source_cursor(src)
        except Exception:
            return {}
        row = con.execute("SELECT payload FROM static_assets WHERE key = ?", [_KEY]).fetchone()
        if not row or not row[0]:
            return {}
        try:
            data = json.loads(row[0])
        except (TypeError, ValueError):
            return {}

        canton_param = params.get("canton")
        if canton_param:
            cantons = {c.strip() for c in canton_param.split(",")}
            data = {k: v for k, v in data.items() if k in cantons}

        try:
            min_boardings = int(params["min_boardings"]) if params.get("min_boardings") else None
        except ValueError:
            min_boardings = None
        try:
            min_transfers = int(params["min_transfers"]) if params.get("min_transfers") else None
        except ValueError:
            min_transfers = None
        stop_ids = None
        if params.get("stop_id"):
            stop_ids = {s.strip() for s in params["stop_id"].split(",")}

        if min_boardings is None and min_transfers is None and stop_ids is None:
            return data

        out: dict = {}
        for canton_key, stops in data.items():
            if not isinstance(stops, list):
                out[canton_key] = stops
                continue
            keep = []
            for stop in stops:
                if not isinstance(stop, dict):
                    keep.append(stop); continue
                if stop_ids is not None and str(stop.get("stop_id", "")) not in stop_ids:
                    continue
                if min_boardings is not None and isinstance(stop.get("boardings"), (int, float)) and stop["boardings"] < min_boardings:
                    continue
                if min_transfers is not None and isinstance(stop.get("transfers"), (int, float)) and stop["transfers"] < min_transfers:
                    continue
                keep.append(stop)
            out[canton_key] = keep
        return out

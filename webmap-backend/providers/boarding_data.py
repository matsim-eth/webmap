"""Boarding data by line — served from the ``static_assets`` BLOB table.

Phase 1: the v1 build leaves ``static_assets`` empty. We return ``{}``
gracefully and rely on the upstream stage to backfill the JSON when PT
data is available.
"""

from __future__ import annotations

import json

from .base import DataProvider, Param
from .connection import default_source, get_source_cursor


_KEY = "boarding_data_by_line"


def _load_static(con) -> list | None:
    row = con.execute(
        "SELECT payload FROM static_assets WHERE key = ?", [_KEY]
    ).fetchone()
    if not row or not row[0]:
        return None
    try:
        data = json.loads(row[0])
    except (TypeError, ValueError):
        return None
    return data


class BoardingDataProvider(DataProvider):
    ROUTE = "boarding_data_by_line.json"
    PARAMS = [
        Param("canton", "Filter by canton name"),
        Param("vehicle", "Filter by vehicle type"),
        Param("line_name", "Filter by line name (exact match)"),
        Param("line_id", "Filter by line ID (exact match)"),
        Param("time_range", "Filter boarding time keys, e.g. '06:00-09:00'"),
    ]

    def deliver(self, params: dict) -> dict:
        src = default_source()
        if not src:
            return {"data": []}
        try:
            con = get_source_cursor(src)
        except Exception:
            return {"data": []}
        data = _load_static(con)
        if data is None:
            return {"data": []}

        entries = list(data.values()) if isinstance(data, dict) else list(data)
        canton = params.get("canton")
        vehicle = params.get("vehicle")
        line_name = params.get("line_name")
        line_id = params.get("line_id")
        time_range = params.get("time_range")

        result = []
        for entry in entries:
            if not isinstance(entry, dict):
                result.append(entry)
                continue
            if canton and isinstance(entry.get("cantons"), list) and canton not in entry["cantons"]:
                continue
            if vehicle and entry.get("vehicle") != vehicle:
                continue
            if line_name and entry.get("line_name") != line_name:
                continue
            if line_id and str(entry.get("line_id")) != str(line_id):
                continue
            if time_range:
                entry = _filter_time_range(entry, time_range)
            result.append(entry)
        return {"data": result}


def _filter_time_range(entry: dict, time_range: str) -> dict:
    parts = time_range.split("-")
    if len(parts) != 2:
        return entry
    start, end = parts[0].strip(), parts[1].strip()
    out = {}
    for k, v in entry.items():
        if isinstance(k, str) and len(k) == 5 and k[2] == ":":
            try:
                if start <= k <= end:
                    out[k] = v
            except (TypeError, ValueError):
                out[k] = v
        else:
            out[k] = v
    return out

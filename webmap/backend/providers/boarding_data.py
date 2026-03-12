import json
import os

from .base import DataProvider
from .paths import get_data_paths


# Per-dataset cache for boarding data
_data_cache: dict[str, list] = {}


class BoardingDataProvider(DataProvider):
    """Boarding data by line, loaded from static JSON and filtered.

    Query params:
        canton     (str): Filter lines whose 'cantons' array contains this canton name.
        vehicle    (str): Filter by vehicle type.
        line_name  (str): Filter by line name (exact match).
        line_id    (str): Filter by line ID (exact match).
        time_range (str): Filter boarding time keys, e.g. "06:00-09:00".

    Example: /data/boarding_data_by_line.json?canton=Zurich&time_range=06:00-09:00
    """

    ROUTE = "boarding_data_by_line.json"

    def _load(self) -> list:
        paths = get_data_paths()
        cache_key = paths.json_preview_dir
        if cache_key not in _data_cache:
            filepath = os.path.join(paths.json_preview_dir, "boarding_data_by_line.json")
            with open(filepath, "r") as f:
                _data_cache[cache_key] = json.load(f)
        return _data_cache[cache_key]

    def deliver(self, params: dict) -> dict:
        data = self._load()

        canton = params.get("canton")
        vehicle = params.get("vehicle")
        line_name = params.get("line_name")
        line_id = params.get("line_id")
        time_range = params.get("time_range")

        filtered = data
        if isinstance(filtered, dict):
            # If top-level is a dict, work with its values or return as-is
            entries = list(filtered.values()) if not isinstance(filtered, list) else filtered
        else:
            entries = list(filtered)

        result = []
        for entry in entries:
            if not isinstance(entry, dict):
                result.append(entry)
                continue

            if canton and "cantons" in entry:
                cantons_list = entry["cantons"]
                if isinstance(cantons_list, list) and canton not in cantons_list:
                    continue

            if vehicle and entry.get("vehicle") != vehicle:
                continue

            if line_name and entry.get("line_name") != line_name:
                continue

            if line_id and str(entry.get("line_id")) != str(line_id):
                continue

            if time_range:
                entry = self._filter_time_range(entry, time_range)

            result.append(entry)

        return {"data": result}

    @staticmethod
    def _filter_time_range(entry: dict, time_range: str) -> dict:
        """Filter boarding time keys within the given range (e.g. '06:00-09:00')."""
        parts = time_range.split("-")
        if len(parts) != 2:
            return entry
        start, end = parts[0].strip(), parts[1].strip()

        filtered_entry = {}
        for key, value in entry.items():
            # Check if the key looks like a time (HH:MM format)
            if isinstance(key, str) and len(key) == 5 and key[2] == ":":
                try:
                    if start <= key <= end:
                        filtered_entry[key] = value
                except (TypeError, ValueError):
                    filtered_entry[key] = value
            else:
                filtered_entry[key] = value

        return filtered_entry

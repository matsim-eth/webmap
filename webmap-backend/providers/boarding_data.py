from .base import DataProvider, Param
from .constants import canton_name
from .helpers import load_static_asset
from .paths import dataset_key


# Per-dataset cache for boarding data, keyed by dataset root.
_data_cache: dict[str, list] = {}
# Per-(dataset, canton) counts cache for per_canton_counts files.
_counts_cache: dict[tuple, list] = {}


def per_canton_counts(canton_id: int) -> list:
    """Rebuild the dashboard's ``per_canton_counts/{canton}_counts.json`` rows
    from the boarding_data static_asset: one row per (line, stop) whose stop is
    in *canton_id*, with the per-time-bin boardings/alightings. Cached."""
    ckey = (dataset_key(), canton_id)
    if ckey in _counts_cache:
        return _counts_cache[ckey]
    lines = BoardingDataProvider()._load()
    rows = []
    for line in lines:
        lid = line.get("line_id")
        for stop in line.get("stops", []):
            if stop.get("canton_id") != canton_id:
                continue
            rows.append({
                "line_id": lid,
                "line_name": line.get("line_name"),
                "stop_id": stop.get("stop_id"),
                "data": [
                    {
                        # The dashboard keys hourly bins on "HH:MM" labels; the
                        # boarding asset is hourly, so emit the top-of-hour label.
                        "time_bin": f"{int(d.get('hour', 0)):02d}:00",
                        "boardings": d.get("boardings", 0),
                        "alightings": d.get("alightings", 0),
                    }
                    for d in stop.get("data", [])
                ],
            })
    _counts_cache[ckey] = rows
    return rows


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
    PARAMS = [
        Param("canton", "Filter by canton name"),
        Param("vehicle", "Filter by vehicle type"),
        Param("line_name", "Filter by line name (exact match)"),
        Param("line_id", "Filter by line ID (exact match)"),
        Param("time_range", "Filter boarding time keys, e.g. '06:00-09:00'"),
    ]

    def _load(self) -> list:
        dk = dataset_key()
        if dk not in _data_cache:
            raw = load_static_asset("synthetic", "boarding_data_by_line")
            if raw is None:
                raise FileNotFoundError("boarding_data_by_line not in static_assets")
            # v2 ships `modes` (array) + canton-id list; the frontend expects a
            # single `vehicle` field and canton names.
            # Drop empty line variants (0 stops / no data): the v2 schedule
            # ships ~1255 such placeholder records (replacement-service codes
            # EV/B/EXT/…) that otherwise pollute the line search and let a user
            # land on a variant whose charts are all zero.
            raw = [l for l in raw if l.get("stops")]
            for line in raw:
                modes = line.get("modes") or []
                line["vehicle"] = modes[0] if modes else None
                line["cantons"] = [canton_name(c) for c in (line.get("cantons") or [])]
            _data_cache[dk] = raw
        return _data_cache[dk]

    def deliver(self, params: dict) -> dict:
        try:
            data = self._load()
        except FileNotFoundError:
            return {"error": "boarding_data_by_line.json not available in this dataset "
                             "(json_preview assets were not built)"}

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

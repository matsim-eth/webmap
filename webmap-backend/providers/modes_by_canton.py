"""Distinct transport modes per canton.

Reads ``hot_polygon_trips`` (canton-scope rows) and lists modes that have
non-zero trip counts. Faster than scanning trips because the precomputed
counts already tell us which modes are present.
"""

from __future__ import annotations

from .base import DataProvider, Param, CANTON, SOURCE
from .connection import get_source_cursor
from .helpers import parse_source_param
from .zone_registry import get_registry
from ._pre_agg import resolve_polygon_ids


# Mapping from hot_polygon_trips count column to the legacy mode name
MODE_COL = {
    "mode_car":           "car",
    "mode_pt":            "pt",
    "mode_walk":          "walk",
    "mode_bike":          "bike",
    "mode_car_passenger": "car_passenger",
}


class ModesByCantonProvider(DataProvider):
    ROUTE = "modes_by_canton.json"
    PARAMS = [
        CANTON, SOURCE,
        Param("exclude_modes", "Comma-separated modes to exclude from results"),
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        exclude = set()
        if params.get("exclude_modes"):
            exclude = {m.strip() for m in params["exclude_modes"].split(",")}

        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        reg = get_registry()
        cols = list(MODE_COL.keys())
        cols_sql = ", ".join(cols)
        # Aggregate union of modes-present across all sources
        result: dict[str, list[str]] = {}
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            placeholders = ",".join(["?"] * len(polygon_ids))
            rows = con.execute(f"""
                SELECT polygon_id, {cols_sql}
                FROM hot_polygon_trips
                WHERE polygon_id IN ({placeholders})
            """, polygon_ids).fetchall()
            for r in rows:
                pid = r[0]
                if not pid.startswith(reg.prefix):
                    continue
                try:
                    cid = int(pid.split(":", 1)[1])
                except ValueError:
                    continue
                modes_here: set[str] = set()
                for col, val in zip(cols, r[1:]):
                    if val and val > 0 and MODE_COL[col] not in exclude:
                        modes_here.add(MODE_COL[col])
                cname = reg.zone_name(cid)
                existing = set(result.get(cname, []))
                result[cname] = sorted(existing | modes_here)
        return result

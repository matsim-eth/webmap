"""Activity-duration distribution per polygon and purpose.

Always raw scan against ``activities`` (with R-tree polygon join). The
v1 schema does not pre-aggregate durations.
"""

from __future__ import annotations

from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, PURPOSE
from .connection import get_source_cursor
from .helpers import (
    get_hot_polygon_meta,
    parse_source_param,
    purpose_filter_sql,
)
from ._pre_agg import label_for, make_label_resolver, polygon_filter_clause, resolve_polygon_ids, _source_label


def _slot_label(minutes: int) -> str:
    h, m = minutes // 60, minutes % 60
    return f"{h}:{m:02d}:00"


class ActivityDurationsProvider(DataProvider):
    ROUTE = "activity_durations.json"
    PARAMS = [
        CANTON, SOURCE, PURPOSE,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("step_min", "Slot width in minutes (default 30)", param_type="integer"),
        Param("max_hours", "Maximum duration in hours (default 24)", param_type="integer"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        try:
            step = int(params.get("step_min", 30))
            max_hours = int(params.get("max_hours", 24))
        except ValueError:
            step, max_hours = 30, 24
        max_min = max_hours * 60
        max_slot = max_min - step
        slots = list(range(0, max_min, step))

        pf = purpose_filter_sql(params, "a.purpose")

        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        counts: dict = defaultdict(int)
        purposes_seen: set = set()
        labels_seen: set = set()

        slot_expr = (
            f"LEAST((CAST(FLOOR((a.end_time - a.start_time) / 60) AS INTEGER) / {step}) * {step}, {max_slot})"
        )

        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            slabel = _source_label(source)

            if polygon_ids:
                # For activities we filter on a.location_pt (the activity location,
                # not the person's home). For canton-typed polygons we cannot use
                # the canton_id shortcut (activities have no canton_id), so we
                # always do the spatial join.
                placeholders = ",".join(["?"] * len(polygon_ids))
                resolve = make_label_resolver(con, polygon_ids, False)
                rows = con.execute(f"""
                    SELECT hp.polygon_id AS poly_key, a.purpose, {slot_expr} AS slot, COUNT(*) AS cnt
                    FROM activities a
                    JOIN hot_polygons hp ON hp.polygon_id IN ({placeholders})
                       AND ST_Within(a.location_pt, hp.polygon_geom)
                    WHERE a.start_time IS NOT NULL AND a.end_time IS NOT NULL
                      AND a.end_time >= a.start_time
                    {pf}
                    GROUP BY hp.polygon_id, a.purpose, slot
                """, polygon_ids).fetchall()
                for pid, purpose, slot, cnt in rows:
                    label = resolve(pid)
                    labels_seen.add(label)
                    purposes_seen.add(str(purpose))
                    counts[(label, slabel, str(purpose), int(slot))] += int(cnt)

            rows_all = con.execute(f"""
                SELECT a.purpose, {slot_expr} AS slot, COUNT(*) FROM activities a
                WHERE a.start_time IS NOT NULL AND a.end_time IS NOT NULL
                  AND a.end_time >= a.start_time
                {pf}
                GROUP BY a.purpose, slot
            """).fetchall()
            for purpose, slot, cnt in rows_all:
                purposes_seen.add(str(purpose))
                counts[("All", slabel, str(purpose), int(slot))] += int(cnt)

        # All-purpose rollups
        for (label, src, purpose, slot), cnt in list(counts.items()):
            if purpose != "All":
                counts[(label, src, "All", slot)] += cnt

        totals: dict = defaultdict(int)
        for (label, src, purpose, slot), cnt in counts.items():
            totals[(label, src, purpose)] += cnt

        purposes = sorted(purposes_seen) + ["All"]
        out: dict = {}
        for label in list(labels_seen) + ["All"]:
            for source in sources:
                slabel = _source_label(source)
                for purpose in purposes:
                    denom = float(totals.get((label, slabel, purpose), 0))
                    slot_data = {
                        _slot_label(s): round(float(counts.get((label, slabel, purpose, s), 0)) / denom, 8)
                        if denom > 0 else 0.0
                        for s in slots
                    }
                    out.setdefault(label, {}).setdefault(slabel, {})[purpose] = slot_data
        return out

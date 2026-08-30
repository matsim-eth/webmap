"""Departure-time distribution per polygon, by purpose.

Always raw scan of trips JOIN persons (we need flexible binning windows
that the pre-aggregated 24x1h grid columns can't express directly).
"""

from __future__ import annotations

from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, MODE
from .connection import get_source_cursor
from .helpers import (
    age_filter_sql,
    gender_filter_sql,
    get_hot_polygon_meta,
    mode_filter_sql,
    parse_source_param,
)
from ._pre_agg import label_for, polygon_filter_clause, primary_fast_path, resolve_polygon_ids, _source_label


def _slot_label(minutes: int) -> str:
    h, m = minutes // 60, minutes % 60
    return f"{h}:{m:02d}:00"


class DepartureTimesProvider(DataProvider):
    ROUTE = "departure_times.json"
    PARAMS = [
        CANTON, SOURCE, MODE,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("start_min", "Start of time window in minutes from midnight", default=0, param_type="integer"),
        Param("end_min", "End of time window in minutes from midnight", default=1440, param_type="integer"),
        Param("step_min", "Bin width in minutes", default=30, param_type="integer"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        try:
            start_min = int(params.get("start_min", 0))
            end_min   = int(params.get("end_min", 1440))
            step      = int(params.get("step_min", 30))
        except ValueError:
            start_min, end_min, step = 0, 1440, 30
        slots = list(range(start_min, end_min, step))

        gf = gender_filter_sql(params, "p.sex")
        af = age_filter_sql(params, "p.age")
        mf = mode_filter_sql(params, "t.main_mode")
        person_join = bool(gf or af)

        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        # counts[(label, source, purpose, slot)] = cnt
        counts: dict = defaultdict(int)
        purposes_seen: set = set()
        labels_seen: set = set()

        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            slabel = _source_label(source)

            slot_expr = f"CAST(FLOOR((t.departure_time / 60 - {start_min}) / {step}) * {step} + {start_min} AS INTEGER)"

            if polygon_ids:
                join, where, group_expr, bind, label_fn = polygon_filter_clause(polygon_ids)
                rows = con.execute(f"""
                    SELECT {group_expr} AS poly_key, t.following_purpose AS purpose,
                           {slot_expr} AS slot, COUNT(*) AS cnt
                    FROM trips t
                    JOIN persons p ON p.person_id = t.person_id
                    {join}
                    WHERE t.departure_time IS NOT NULL
                      AND t.following_purpose IS NOT NULL
                      AND t.departure_time / 60 >= {start_min}
                      AND t.departure_time / 60 < {end_min}
                    {where}{gf}{af}{mf}
                    GROUP BY poly_key, purpose, slot
                """, bind).fetchall()
                meta = get_hot_polygon_meta(con, polygon_ids) if not primary_fast_path(polygon_ids) else None
                for poly_key, purpose, slot, cnt in rows:
                    pid = label_fn(poly_key)
                    label = label_for(pid, meta)
                    labels_seen.add(label)
                    purposes_seen.add(str(purpose))
                    counts[(label, slabel, str(purpose), int(slot))] += int(cnt)

            join = "JOIN persons p ON p.person_id = t.person_id" if person_join else ""
            rows_all = con.execute(f"""
                SELECT t.following_purpose AS purpose, {slot_expr} AS slot, COUNT(*)
                FROM trips t {join}
                WHERE t.departure_time IS NOT NULL
                  AND t.following_purpose IS NOT NULL
                  AND t.departure_time / 60 >= {start_min}
                  AND t.departure_time / 60 < {end_min}
                {gf}{af}{mf}
                GROUP BY purpose, slot
            """).fetchall()
            for purpose, slot, cnt in rows_all:
                purposes_seen.add(str(purpose))
                counts[("All", slabel, str(purpose), int(slot))] += int(cnt)

        # Build "All" purpose rollup per label
        for (label, src, purpose, slot), cnt in list(counts.items()):
            if purpose != "All":
                counts[(label, src, "All", slot)] += cnt

        # Totals per (label, source, purpose)
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

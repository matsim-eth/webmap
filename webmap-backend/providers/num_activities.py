"""Distribution of number-of-activities per person, per polygon."""

from __future__ import annotations

from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, GENDER
from .connection import get_source_cursor
from .helpers import (
    gender_filter_sql,
    get_hot_polygon_meta,
    parse_source_param,
)
from ._pre_agg import label_for, make_label_resolver, polygon_filter_clause, resolve_polygon_ids, _source_label


class NumActivitiesProvider(DataProvider):
    ROUTE = "num_activities.json"
    PARAMS = [
        CANTON, SOURCE, GENDER,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("max_activities", "Cap activity count at this value (default 19)", param_type="integer"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        try:
            max_act = int(params.get("max_activities", 19))
        except Exception:
            max_act = 19
        gf = gender_filter_sql(params, "p.sex")
        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        out = {}
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue

            counts: dict = defaultdict(int)
            totals: dict = defaultdict(int)
            seen_keys: set = set()

            if polygon_ids:
                join, where, group_expr, bind, _ = polygon_filter_clause(polygon_ids)
                resolve = make_label_resolver(con, polygon_ids,
                                               all(p.startswith("canton:") for p in polygon_ids))
                rows = con.execute(f"""
                    SELECT {group_expr} AS poly_key, LEAST(p.n_activities, {max_act}) AS capped, COUNT(*) AS cnt
                    FROM persons p
                    {join}
                    WHERE p.n_activities IS NOT NULL{where}{gf}
                    GROUP BY poly_key, capped
                """, bind).fetchall()
                per_label: dict[str, dict[str, int]] = defaultdict(dict)
                for poly_key, num, cnt in rows:
                    if num is None:
                        continue
                    label = resolve(poly_key)
                    k = str(int(num))
                    per_label[label][k] = per_label[label].get(k, 0) + cnt
                    seen_keys.add(k)
                for label, vals in per_label.items():
                    denom = float(sum(vals.values()))
                    entry = out.setdefault(label, {}).setdefault(_source_label(source), {})
                    for k in vals.keys():
                        entry[k] = round(vals[k] / denom, 16) if denom > 0 else 0.0

            rows_all = con.execute(f"""
                SELECT LEAST(p.n_activities, {max_act}) AS capped, COUNT(*)
                FROM persons p
                WHERE p.n_activities IS NOT NULL{gf}
                GROUP BY capped
            """).fetchall()
            all_dict: dict[str, int] = {}
            for num, cnt in rows_all:
                if num is None:
                    continue
                k = str(int(num))
                all_dict[k] = cnt
                seen_keys.add(k)
            denom = float(sum(all_dict.values()))
            entry = out.setdefault("All", {}).setdefault(_source_label(source), {})
            for k in all_dict.keys():
                entry[k] = round(all_dict[k] / denom, 16) if denom > 0 else 0.0

            # Backfill missing keys with 0 to keep response shape stable
            keys_sorted = sorted(seen_keys, key=lambda x: int(x))
            for label_dict in out.values():
                src_dict = label_dict.get(_source_label(source))
                if not src_dict:
                    continue
                for k in keys_sorted:
                    src_dict.setdefault(k, 0.0)
        return out

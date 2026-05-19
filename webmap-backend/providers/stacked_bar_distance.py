"""Stacked-bar distance × mode/purpose distribution per polygon."""

from __future__ import annotations

from collections import defaultdict

from .base import DataProvider, Param, TRIP_FILTERS, SUMMARY_ONLY
from .connection import get_source_cursor
from .helpers import (
    age_filter_sql,
    gender_filter_sql,
    get_hot_polygon_meta,
    has_person_filters,
    is_summary_only,
    mode_filter_sql,
    parse_source_param,
    purpose_filter_sql,
)
from ._pre_agg import label_for, make_label_resolver, polygon_filter_clause, resolve_polygon_ids, _source_label


DEFAULT_CATEGORIES = [
    (0, 1000, "0-1000"),
    (1000, 5000, "1000-5000"),
    (5000, 25000, "5000-25000"),
    (25000, float("inf"), "25000+"),
]
_DIST_COLS = {"euclidean": "t.crowfly_distance", "network": "t.network_distance"}


def _parse_categories(params: dict):
    raw = params.get("categories")
    if not raw:
        return DEFAULT_CATEGORIES
    try:
        bounds = [float(x.strip()) for x in raw.split(",")]
    except ValueError:
        return DEFAULT_CATEGORIES
    if len(bounds) < 2:
        return DEFAULT_CATEGORIES
    cats = []
    for i in range(len(bounds) - 1):
        cats.append((bounds[i], bounds[i + 1], f"{int(bounds[i])}-{int(bounds[i + 1])}"))
    cats.append((bounds[-1], float("inf"), f"{int(bounds[-1])}+"))
    return cats


def _case_sql(categories, dist_col):
    parts = []
    for lo, hi, lbl in categories:
        if hi == float("inf"):
            parts.append(f"WHEN {dist_col} >= {lo} THEN '{lbl}'")
        else:
            parts.append(f"WHEN {dist_col} >= {lo} AND {dist_col} < {hi} THEN '{lbl}'")
    return "CASE " + " ".join(parts) + " END"


class StackedBarDistanceProvider(DataProvider):
    ROUTE = "stacked_bar_distance.json"
    PARAMS = TRIP_FILTERS + [
        SUMMARY_ONLY,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("distance_type", "Distance metric", enum=["euclidean", "network"]),
        Param("group_by", "Group results by 'mode' (default) or 'purpose'", enum=["mode", "purpose"]),
        Param("categories", "Comma-separated distance boundaries"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        summary = is_summary_only(params) and not (params.get("canton") or params.get("polygon_id")) and not has_person_filters(params)
        gf = "" if summary else gender_filter_sql(params, "p.sex")
        af = "" if summary else age_filter_sql(params, "p.age")
        mf = mode_filter_sql(params, "t.main_mode")
        pf = purpose_filter_sql(params, "t.following_purpose")
        categories = _parse_categories(params)

        distance_type = (params.get("distance_type") or "euclidean").lower()
        if distance_type not in _DIST_COLS:
            distance_type = "euclidean"
        dist_col = _DIST_COLS[distance_type]
        group_by = (params.get("group_by") or "mode").lower()
        if group_by not in ("mode", "purpose"):
            group_by = "mode"
        grp_col = "t.main_mode" if group_by == "mode" else "t.following_purpose"

        cat_sql = _case_sql(categories, dist_col)

        con0 = get_source_cursor(sources[0])
        polygon_ids = [] if summary else resolve_polygon_ids(con0, params, default_type="canton")

        counts = defaultdict(int)
        cat_totals = defaultdict(int)
        labels_seen: set = set()

        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            slabel = _source_label(source)

            if polygon_ids:
                join, where, group_expr, bind, _ = polygon_filter_clause(polygon_ids)
                resolve = make_label_resolver(con, polygon_ids,
                                               all(p.startswith("canton:") for p in polygon_ids))
                rows = con.execute(f"""
                    SELECT {group_expr} AS poly_key, {grp_col} AS grp, {cat_sql} AS cat, COUNT(*)
                    FROM trips t
                    JOIN persons p ON p.person_id = t.person_id
                    {join}
                    WHERE {dist_col} IS NOT NULL AND {grp_col} IS NOT NULL
                    {where}{gf}{af}{mf}{pf}
                    GROUP BY poly_key, grp, cat HAVING cat IS NOT NULL
                """, bind).fetchall()
                for poly_key, grp, cat, cnt in rows:
                    label = resolve(poly_key)
                    labels_seen.add(label)
                    counts[(label, slabel, str(cat), str(grp))] += int(cnt)
                    cat_totals[(label, slabel, str(cat))] += int(cnt)

            join = "JOIN persons p ON p.person_id = t.person_id" if (gf or af) else ""
            rows_all = con.execute(f"""
                SELECT {grp_col}, {cat_sql} AS cat, COUNT(*)
                FROM trips t {join}
                WHERE {dist_col} IS NOT NULL AND {grp_col} IS NOT NULL
                {gf}{af}{mf}{pf}
                GROUP BY 1, cat HAVING cat IS NOT NULL
            """).fetchall()
            for grp, cat, cnt in rows_all:
                counts[("All", slabel, str(cat), str(grp))] += int(cnt)
                cat_totals[("All", slabel, str(cat))] += int(cnt)

        cat_labels = [c[2] for c in categories]
        grp_values = sorted({k[3] for k in counts})
        result: dict = {}
        for label in list(labels_seen) + ["All"]:
            rows_out = []
            for cat in cat_labels:
                for grp in grp_values:
                    for source in sources:
                        slabel = _source_label(source)
                        cnt = counts.get((label, slabel, cat, grp), 0)
                        total = cat_totals.get((label, slabel, cat), 0)
                        pct = round(cnt / total * 100, 1) if total > 0 else 0.0
                        rows_out.append({
                            "distance_category": cat,
                            group_by: grp,
                            "dataset": slabel,
                            "count": float(cnt),
                            "percentage": pct,
                        })
            result[label] = rows_out
        return result

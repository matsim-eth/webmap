"""Stacked bar chart: distance distribution by mode or purpose."""

from collections import defaultdict

from .base import DataProvider, Param, TRIP_FILTERS, SUMMARY_ONLY
from .connection import get_connection
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    age_filter_sql,
    parse_source_param,
    build_canton_lookup,
    mode_filter_sql,
    purpose_filter_sql,
    is_summary_only,
    has_person_filters,
)
from .paths import get_data_paths

DEFAULT_CATEGORIES = [
    (0, 1000, "0-1000"),
    (1000, 5000, "1000-5000"),
    (5000, 25000, "5000-25000"),
    (25000, float("inf"), "25000+"),
]

_DIST_COLS = {
    "euclidean": ("crowfly_distance", "euclidean_distance"),
    "network":   ("network_distance", "traveled_distance"),
}

_GROUP_COLS = {
    "mode":    ("t.mode", "t.main_mode"),
    "purpose": ("t.purpose", "t.end_activity_type"),
}


def _parse_categories(params: dict) -> list[tuple[float, float, str]]:
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


def _build_case_sql(categories: list[tuple[float, float, str]], dist_col: str) -> str:
    """Build a CASE expression to categorize distances in SQL."""
    parts = []
    for lo, hi, label in categories:
        if hi == float("inf"):
            parts.append(f"WHEN {dist_col} >= {lo} THEN '{label}'")
        else:
            parts.append(f"WHEN {dist_col} >= {lo} AND {dist_col} < {hi} THEN '{label}'")
    return "CASE " + " ".join(parts) + " END"


class StackedBarDistanceProvider(DataProvider):
    ROUTE = "stacked_bar_distance.json"
    PARAMS = TRIP_FILTERS + [
        SUMMARY_ONLY,
        Param("distance_type", "Distance metric", enum=["euclidean", "network"]),
        Param("group_by", "Group results by 'mode' (default) or 'purpose'", enum=["mode", "purpose"]),
        Param("categories", "Comma-separated distance boundaries"),
    ]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        summary = is_summary_only(params) and not params.get("canton") and not has_person_filters(params)
        cf = "" if summary else canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = "" if summary else gender_filter_sql(params, "p.sex")
        af = "" if summary else age_filter_sql(params, "p.age")
        categories = _parse_categories(params)
        con = get_connection()

        distance_type = params.get("distance_type", "euclidean").lower()
        group_by = params.get("group_by", "mode").lower()

        if distance_type not in _DIST_COLS:
            distance_type = "euclidean"
        if group_by not in _GROUP_COLS:
            group_by = "mode"

        mc_dist_col, syn_dist_col = _DIST_COLS[distance_type]
        mc_group_col, syn_group_col = _GROUP_COLS[group_by]

        if group_by == "mode":
            mc_gf = mode_filter_sql(params, mc_group_col)
            syn_gf = mode_filter_sql(params, syn_group_col)
        else:
            mc_gf = purpose_filter_sql(params, mc_group_col)
            syn_gf = purpose_filter_sql(params, syn_group_col)

        counts = defaultdict(int)
        cat_totals = defaultdict(int)
        seen_cantons = set()

        if "Microcensus" in sources:
            case_sql = _build_case_sql(categories, f"t.{mc_dist_col}")
            if summary:
                rows = con.execute(f"""
                    SELECT {mc_group_col} AS grp,
                           {case_sql} AS cat_label,
                           COUNT(*) AS cnt
                    FROM read_parquet(?) t
                    WHERE t.{mc_dist_col} IS NOT NULL
                      AND {mc_group_col} IS NOT NULL
                    {mc_gf}
                    GROUP BY grp, cat_label
                    HAVING cat_label IS NOT NULL
                """, [paths.microcensus_trips]).fetchall()
                for gval, cat, cnt in rows:
                    counts[("Microcensus", "All", str(cat), str(gval))] += cnt
                    cat_totals[("Microcensus", "All", str(cat))] += cnt
            else:
                rows = con.execute(f"""
                    SELECT p.canton_id, {mc_group_col} AS grp,
                           {case_sql} AS cat_label,
                           COUNT(*) AS cnt
                    FROM read_parquet(?) t
                    INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL
                      AND t.{mc_dist_col} IS NOT NULL
                      AND {mc_group_col} IS NOT NULL
                    {cf}{mc_gf}{gf}{af}
                    GROUP BY p.canton_id, grp, cat_label
                    HAVING cat_label IS NOT NULL
                """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
                for cid, gval, cat, cnt in rows:
                    cid = int(cid)
                    seen_cantons.add(cid)
                    counts[("Microcensus", cid, str(cat), str(gval))] += cnt
                    cat_totals[("Microcensus", cid, str(cat))] += cnt

        if "Synthetic" in sources:
            case_sql = _build_case_sql(categories, f"t.{syn_dist_col}")
            if summary:
                rows = con.execute(f"""
                    SELECT {syn_group_col} AS grp,
                           {case_sql} AS cat_label,
                           COUNT(*) AS cnt
                    FROM read_parquet(?) t
                    WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                      AND t.{syn_dist_col} IS NOT NULL
                      AND {syn_group_col} IS NOT NULL
                    {syn_gf}
                    GROUP BY grp, cat_label
                    HAVING cat_label IS NOT NULL
                """, [paths.synthetic_output_trips]).fetchall()
                for gval, cat, cnt in rows:
                    counts[("Synthetic", "All", str(cat), str(gval))] += cnt
                    cat_totals[("Synthetic", "All", str(cat))] += cnt
            else:
                rows = con.execute(f"""
                    SELECT p.canton_id, {syn_group_col} AS grp,
                           {case_sql} AS cat_label,
                           COUNT(*) AS cnt
                    FROM read_parquet(?) t
                    INNER JOIN read_parquet(?) p
                        ON TRY_CAST(t.person AS BIGINT) = p.person_id
                    WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                      AND p.canton_id IS NOT NULL
                      AND t.{syn_dist_col} IS NOT NULL
                      AND {syn_group_col} IS NOT NULL
                    {cf}{syn_gf}{gf}{af}
                    GROUP BY p.canton_id, grp, cat_label
                    HAVING cat_label IS NOT NULL
                """, [paths.synthetic_output_trips, paths.synthetic_persons]).fetchall()
                for cid, gval, cat, cnt in rows:
                    cid = int(cid)
                    seen_cantons.add(cid)
                    counts[("Synthetic", cid, str(cat), str(gval))] += cnt
                    cat_totals[("Synthetic", cid, str(cat))] += cnt

        # "All" canton aggregate (skip in summary mode — already accumulated under "All")
        if not summary:
            all_canton_counts = defaultdict(int)
            all_canton_totals = defaultdict(int)
            for (source, cid, cat, gval), cnt in counts.items():
                all_canton_counts[(source, "All", cat, gval)] += cnt
            counts.update(all_canton_counts)
            for (source, cid, cat), total in cat_totals.items():
                all_canton_totals[(source, "All", cat)] += total
            cat_totals.update(all_canton_totals)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        cat_labels = [c[2] for c in categories]
        group_values = sorted({k[3] for k in counts})

        result: dict = {}
        canton_list = ["All"] if summary else canton_names + ["All"]
        for cname in canton_list:
            cid = canton_ids_by_name.get(cname, "All")
            rows_out = []
            for cat_label in cat_labels:
                for gval in group_values:
                    for source in sources:
                        cnt = counts.get((source, cid, cat_label, gval), 0)
                        total = cat_totals.get((source, cid, cat_label), 0)
                        pct = round(cnt / total * 100, 1) if total > 0 else 0.0
                        rows_out.append({
                            "distance_category": cat_label,
                            group_by: gval,
                            "dataset": source,
                            "count": float(cnt),
                            "percentage": pct,
                        })
            result[cname] = rows_out

        return result

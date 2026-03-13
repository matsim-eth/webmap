"""Stacked bar chart: distance distribution by mode or purpose.

Consolidates the former 4 endpoints into 1:
  stacked_bar_euclidean_distance_mode.json    -> ?distance_type=euclidean&group_by=mode
  stacked_bar_euclidean_distance_purpose.json -> ?distance_type=euclidean&group_by=purpose
  stacked_bar_network_distance_mode.json      -> ?distance_type=network&group_by=mode
  stacked_bar_network_distance_purpose.json   -> ?distance_type=network&group_by=purpose

Query params
------------
distance_type (str): "euclidean" (default) or "network".
group_by      (str): "mode" (default) or "purpose".
canton        (str): Comma-separated canton names.
source        (str): "Synthetic", "Microcensus", or omit for both.
mode          (str): Comma-separated transport modes to include.
purpose       (str): Comma-separated purposes to include.
categories    (str): Comma-separated distance boundaries (e.g. "0,1000,5000,25000").
gender        (str): "0" or "1" to filter by sex.
age_min       (int): Minimum age (inclusive).
age_max       (int): Maximum age (exclusive).
"""

import duckdb

from .base import DataProvider, Param, TRIP_FILTERS
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    age_filter_sql,
    parse_source_param,
    build_canton_lookup,
    mode_filter_sql,
    purpose_filter_sql,
)
from .paths import get_data_paths

DEFAULT_CATEGORIES = [
    (0, 1000, "0-1000"),
    (1000, 5000, "1000-5000"),
    (5000, 25000, "5000-25000"),
    (25000, float("inf"), "25000+"),
]

# Column mapping: (distance_type) -> (mc_col, syn_col)
_DIST_COLS = {
    "euclidean": ("crowfly_distance", "euclidean_distance"),
    "network":   ("network_distance", "traveled_distance"),
}

# Group column mapping: (group_by) -> (mc_col, syn_col)
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


def _categorize(distance: float, categories: list[tuple[float, float, str]]) -> str | None:
    for lo, hi, label in categories:
        if lo <= distance < hi:
            return label
    return None


class StackedBarDistanceProvider(DataProvider):
    ROUTE = "stacked_bar_distance.json"
    PARAMS = TRIP_FILTERS + [
        Param("distance_type", "Distance metric", enum=["euclidean", "network"]),
        Param("group_by", "Group results by 'mode' (default) or 'purpose'", enum=["mode", "purpose"]),
        Param("categories", "Comma-separated distance boundaries (e.g. '0,1000,5000,25000')"),
    ]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = gender_filter_sql(params, "p.sex")
        af = age_filter_sql(params, "p.age")
        categories = _parse_categories(params)
        con = duckdb.connect()

        distance_type = params.get("distance_type", "euclidean").lower()
        group_by = params.get("group_by", "mode").lower()

        if distance_type not in _DIST_COLS:
            distance_type = "euclidean"
        if group_by not in _GROUP_COLS:
            group_by = "mode"

        mc_dist_col, syn_dist_col = _DIST_COLS[distance_type]
        mc_group_col, syn_group_col = _GROUP_COLS[group_by]

        # Build group filters per source
        if group_by == "mode":
            mc_gf = mode_filter_sql(params, mc_group_col)
            syn_gf = mode_filter_sql(params, syn_group_col)
        else:
            mc_gf = purpose_filter_sql(params, mc_group_col)
            syn_gf = purpose_filter_sql(params, syn_group_col)

        counts: dict = {}
        cat_totals: dict = {}
        seen_cantons: set = set()

        def accumulate(source: str, cid: int, distance: float, group_val: str) -> None:
            cat_label = _categorize(distance, categories)
            if cat_label is None:
                return
            seen_cantons.add(cid)
            for c in (cid, "All"):
                key = (source, c, cat_label, group_val)
                counts[key] = counts.get(key, 0) + 1
                tkey = (source, c, cat_label)
                cat_totals[tkey] = cat_totals.get(tkey, 0) + 1

        if "Microcensus" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, t.{mc_dist_col}, {mc_group_col}
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.{mc_dist_col} IS NOT NULL
                  AND {mc_group_col} IS NOT NULL
                {cf}{mc_gf}{gf}{af}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, dist, gval in rows:
                accumulate("Microcensus", int(cid), float(dist), str(gval))

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, t.{syn_dist_col}, {syn_group_col}
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p
                    ON TRY_CAST(t.person AS BIGINT) = p.person_id
                WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                  AND p.canton_id IS NOT NULL
                  AND t.{syn_dist_col} IS NOT NULL
                  AND {syn_group_col} IS NOT NULL
                {cf}{syn_gf}{gf}{af}
            """, [paths.synthetic_output_trips, paths.synthetic_persons]).fetchall()
            for cid, dist, gval in rows:
                accumulate("Synthetic", int(cid), float(dist), str(gval))

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        cat_labels = [c[2] for c in categories]
        group_values = sorted({k[3] for k in counts})

        result: dict = {}
        for cname in canton_names + ["All"]:
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

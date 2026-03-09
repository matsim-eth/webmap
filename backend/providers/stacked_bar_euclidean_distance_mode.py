import duckdb

from .base import DataProvider
from .constants import canton_name
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
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


def _parse_categories(params: dict) -> list[tuple[float, float, str]]:
    """Parse custom distance categories from comma-separated boundaries.

    E.g. "0,1000,5000,25000" -> [(0,1000,"0-1000"), (1000,5000,"1000-5000"), ...]
    The last bin extends to infinity.
    """
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
    """Base class for stacked bar distance providers.

    Subclasses set:
        ROUTE               - endpoint filename
        MC_DISTANCE_COL     - microcensus distance column name
        SYN_DISTANCE_COL    - synthetic distance column name
        GROUP_BY            - "mode" or "purpose"
    """

    ROUTE: str
    MC_DISTANCE_COL: str
    SYN_DISTANCE_COL: str
    GROUP_BY: str  # "mode" or "purpose"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = gender_filter_sql(params, "p.sex")
        categories = _parse_categories(params)
        con = duckdb.connect()

        is_mode = self.GROUP_BY == "mode"

        if is_mode:
            group_filter = mode_filter_sql(params, "t.mode" if "micro" else "t.main_mode")
        else:
            group_filter = purpose_filter_sql(params, "t.purpose" if "micro" else "t.end_activity_type")

        # key: (source, canton_id_or_"All", category_label, group_value) -> count
        counts: dict = {}
        # key: (source, canton_id_or_"All", category_label) -> total
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
            mc_group_col = "t.mode" if is_mode else "t.purpose"
            mc_gf = mode_filter_sql(params, "t.mode") if is_mode else purpose_filter_sql(params, "t.purpose")
            rows = con.execute(f"""
                SELECT p.canton_id, t.{self.MC_DISTANCE_COL}, {mc_group_col}
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.{self.MC_DISTANCE_COL} IS NOT NULL
                  AND {mc_group_col} IS NOT NULL
                {cf}{mc_gf}{gf}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, dist, gval in rows:
                accumulate("Microcensus", int(cid), float(dist), str(gval))

        if "Synthetic" in sources:
            syn_group_col = "t.main_mode" if is_mode else "t.end_activity_type"
            syn_gf = mode_filter_sql(params, "t.main_mode") if is_mode else purpose_filter_sql(params, "t.end_activity_type")
            rows = con.execute(f"""
                SELECT p.canton_id, t.{self.SYN_DISTANCE_COL}, {syn_group_col}
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p
                    ON TRY_CAST(t.person AS BIGINT) = p.person_id
                WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                  AND p.canton_id IS NOT NULL
                  AND t.{self.SYN_DISTANCE_COL} IS NOT NULL
                  AND {syn_group_col} IS NOT NULL
                {cf}{syn_gf}{gf}
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
                            self.GROUP_BY: gval,
                            "dataset": source,
                            "count": float(cnt),
                            "percentage": pct,
                        })
            result[cname] = rows_out

        return result


class StackedBarEuclideanDistanceModeProvider(StackedBarDistanceProvider):
    """Stacked bar chart: euclidean distance grouped by mode.

    Query params:
        canton     (str): Comma-separated canton names.
        source     (str): "Synthetic", "Microcensus", or omit for both.
        mode       (str): Comma-separated transport modes to include.
        categories (str): Comma-separated distance boundaries (e.g. "0,1000,5000,25000").
        gender     (str): "0" or "1" to filter by sex.
    """

    ROUTE = "stacked_bar_euclidean_distance_mode.json"
    MC_DISTANCE_COL = "crowfly_distance"
    SYN_DISTANCE_COL = "euclidean_distance"
    GROUP_BY = "mode"

"""Histogram of distance distribution by mode or purpose.

Consolidates the former 4 endpoints into 1:
  histogram_euclidean_distance_mode.json    -> ?distance_type=euclidean&group_by=mode
  histogram_euclidean_distance_purpose.json -> ?distance_type=euclidean&group_by=purpose
  histogram_network_distance_mode.json      -> ?distance_type=network&group_by=mode
  histogram_network_distance_purpose.json   -> ?distance_type=network&group_by=purpose

Query params
------------
distance_type (str): "euclidean" (default) or "network".
group_by      (str): "mode" (default) or "purpose".
canton        (str): Comma-separated canton names.
source        (str): "Synthetic", "Microcensus", or omit for both.
mode          (str): Comma-separated transport modes to include.
purpose       (str): Comma-separated purposes to include.
num_bins      (int): Number of histogram bins (default 100).
max_distance  (float): Cap the maximum distance used for binning.
gender        (str): "0" or "1" to filter by sex.
age_min       (int): Minimum age (inclusive).
age_max       (int): Maximum age (exclusive).
"""

import duckdb

from .base import DataProvider, Param, TRIP_FILTERS
from .helpers import (
    canton_filter_sql,
    parse_source_param,
    build_canton_lookup,
    mode_filter_sql,
    purpose_filter_sql,
    gender_filter_sql,
    age_filter_sql,
)
from .paths import get_data_paths

# Column mapping per distance type and source
_DIST_COLS = {
    "euclidean": ("t.crowfly_distance", "t.euclidean_distance"),
    "network":   ("t.network_distance", "t.traveled_distance"),
}
_GROUP_COLS = {
    "mode":    ("t.mode", "t.main_mode"),
    "purpose": ("t.purpose", "t.end_activity_type"),
}


def _load_distance_data(con, paths, sources, distance_type, group_col, canton_filter="", extra_filter=""):
    micro_dist_col, synth_dist_col = _DIST_COLS[distance_type]
    micro_group_col, synth_group_col = _GROUP_COLS[group_col]

    result: dict[int | str, list[tuple[str, float, str]]] = {}

    def _append(canton_id: int, group_value: str, distance: float, source: str):
        for key in (canton_id, "All"):
            result.setdefault(key, []).append((group_value, distance, source))

    if "Microcensus" in sources:
        rows = con.execute(f"""
            SELECT p.canton_id, {micro_group_col} AS grp, {micro_dist_col} AS dist
            FROM read_parquet(?) t
            INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
            WHERE p.canton_id IS NOT NULL
              AND {micro_group_col} IS NOT NULL
              AND {micro_dist_col} IS NOT NULL
            {canton_filter}{extra_filter}
        """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
        for cid, grp, dist in rows:
            _append(int(cid), str(grp), float(dist), "Microcensus")

    if "Synthetic" in sources:
        rows = con.execute(f"""
            SELECT p.canton_id, {synth_group_col} AS grp, {synth_dist_col} AS dist
            FROM read_parquet(?) t
            INNER JOIN read_parquet(?) p
                ON TRY_CAST(t.person AS BIGINT) = p.person_id
            WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
              AND p.canton_id IS NOT NULL
              AND {synth_group_col} IS NOT NULL
              AND {synth_dist_col} IS NOT NULL
            {canton_filter}{extra_filter}
        """, [paths.synthetic_output_trips, paths.synthetic_persons]).fetchall()
        for cid, grp, dist in rows:
            _append(int(cid), str(grp), float(dist), "Synthetic")

    return result


def _compute_histogram(values: list[float], bin_width: float, num_bins: int):
    n = len(values)
    if n == 0:
        return [0.0] * num_bins, 0.0, 0
    counts = [0] * num_bins
    total = 0.0
    for v in values:
        idx = int(v / bin_width) if bin_width > 0 else 0
        if idx >= num_bins:
            idx = num_bins - 1
        counts[idx] += 1
        total += v
    percentages = [(c / n) * 100.0 for c in counts]
    mean = total / n
    return percentages, mean, n


class HistogramDistanceProvider(DataProvider):
    ROUTE = "histogram_distance.json"
    PARAMS = TRIP_FILTERS + [
        Param("distance_type", "Distance metric", enum=["euclidean", "network"]),
        Param("group_by", "Group results by 'mode' (default) or 'purpose'", enum=["mode", "purpose"]),
        Param("num_bins", "Number of histogram bins (default 100)", param_type="integer"),
        Param("max_distance", "Cap maximum distance for binning", param_type="number"),
    ]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")

        distance_type = params.get("distance_type", "euclidean").lower()
        group_by = params.get("group_by", "mode").lower()

        if distance_type not in ("euclidean", "network"):
            distance_type = "euclidean"
        if group_by not in ("mode", "purpose"):
            group_by = "mode"

        # Build the appropriate group filter
        if group_by == "mode":
            gf_micro = mode_filter_sql(params, "t.mode")
            gf_synth = mode_filter_sql(params, "t.main_mode")
        else:
            gf_micro = purpose_filter_sql(params, "t.purpose")
            gf_synth = purpose_filter_sql(params, "t.end_activity_type")

        # Extra person-level filters
        extra_person = gender_filter_sql(params, "p.sex") + age_filter_sql(params, "p.age")
        gf_micro += extra_person
        gf_synth += extra_person

        try:
            num_bins = int(params.get("num_bins", 100))
        except ValueError:
            num_bins = 100

        max_distance_param = params.get("max_distance")
        try:
            max_distance_cap = float(max_distance_param) if max_distance_param else None
        except ValueError:
            max_distance_cap = None

        con = duckdb.connect()

        raw: dict[int | str, list[tuple[str, float, str]]] = {}

        if "Microcensus" in sources:
            micro_data = _load_distance_data(
                con, paths, ["Microcensus"],
                distance_type, group_by,
                canton_filter=cf, extra_filter=gf_micro,
            )
            for key, rows in micro_data.items():
                raw.setdefault(key, []).extend(rows)

        if "Synthetic" in sources:
            synth_data = _load_distance_data(
                con, paths, ["Synthetic"],
                distance_type, group_by,
                canton_filter=cf, extra_filter=gf_synth,
            )
            for key, rows in synth_data.items():
                raw.setdefault(key, []).extend(rows)

        seen_cantons = {k for k in raw if k != "All"}
        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        result: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            entries = raw.get(cid, [])
            if not entries:
                continue

            by_group: dict[str, dict[str, list[float]]] = {}
            for grp, dist, src in entries:
                by_group.setdefault(grp, {}).setdefault(src, []).append(dist)

            canton_result: dict = {}
            for grp in sorted(by_group):
                source_dists = by_group[grp]
                all_dists = []
                for dists in source_dists.values():
                    all_dists.extend(dists)
                if not all_dists:
                    continue

                max_dist = max(all_dists)
                if max_distance_cap is not None and max_distance_cap > 0:
                    max_dist = min(max_dist, max_distance_cap)
                if max_dist <= 0 or num_bins <= 0:
                    continue

                bin_width = round(max_dist / num_bins, 2)
                if bin_width <= 0:
                    continue

                bins = [round(i * bin_width, 2) for i in range(num_bins + 1)]

                micro_hist, micro_mean, micro_n = _compute_histogram(
                    source_dists.get("Microcensus", []), bin_width, num_bins,
                )
                synth_hist, synth_mean, synth_n = _compute_histogram(
                    source_dists.get("Synthetic", []), bin_width, num_bins,
                )

                canton_result[grp] = {
                    "bin_width": bin_width,
                    "bins": bins,
                    "microcensus_histogram": micro_hist,
                    "synthetic_histogram": synth_hist,
                    "microcensus_mean": round(micro_mean, 6),
                    "synthetic_mean": round(synth_mean, 6),
                    "microcensus_sample_size": micro_n,
                    "synthetic_sample_size": synth_n,
                }

            if canton_result:
                result[cname] = canton_result

        return result

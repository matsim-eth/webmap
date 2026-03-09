"""Shared helpers and base classes for distance-distribution providers."""

import duckdb

from .base import DataProvider
from .constants import canton_name
from .helpers import (
    canton_filter_sql,
    parse_source_param,
    build_canton_lookup,
    mode_filter_sql,
    purpose_filter_sql,
)
from .paths import get_data_paths


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_distance_data(
    con,
    paths,
    sources: list[str],
    distance_type: str,
    group_col: str,
    canton_filter: str = "",
    extra_filter: str = "",
) -> dict[int | str, list[tuple[str, float, str]]]:
    """Load trip distance data from one or both data sources.

    Returns a dict keyed by canton_id (int) or ``"All"`` whose values are
    lists of ``(group_value, distance_value, source_label)`` tuples.

    Parameters
    ----------
    con : duckdb.DuckDBPyConnection
        An open DuckDB connection.
    paths : DataPaths
        Result of :func:`get_data_paths`.
    sources : list[str]
        ``["Synthetic"]``, ``["Microcensus"]``, or both.
    distance_type : str
        ``"euclidean"`` or ``"network"``.
    group_col : str
        ``"mode"`` or ``"purpose"``.
    canton_filter : str
        SQL fragment for canton filtering (e.g. from :func:`canton_filter_sql`).
    extra_filter : str
        Additional SQL WHERE clause fragment (e.g. mode/purpose filter).
    """

    # Column mapping per source
    if distance_type == "euclidean":
        micro_dist_col = "t.crowfly_distance"
        synth_dist_col = "t.euclidean_distance"
    else:  # network
        micro_dist_col = "t.network_distance"
        synth_dist_col = "t.traveled_distance"

    if group_col == "mode":
        micro_group_col = "t.mode"
        synth_group_col = "t.main_mode"
    else:  # purpose
        micro_group_col = "t.purpose"
        synth_group_col = "t.end_activity_type"

    result: dict[int | str, list[tuple[str, float, str]]] = {}

    def _append(canton_id: int, group_value: str, distance: float, source: str):
        for key in (canton_id, "All"):
            result.setdefault(key, []).append((group_value, distance, source))

    if "Microcensus" in sources:
        rows = con.execute(
            f"""
            SELECT p.canton_id,
                   {micro_group_col}  AS grp,
                   {micro_dist_col}   AS dist
            FROM read_parquet(?) t
            INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
            WHERE p.canton_id IS NOT NULL
              AND {micro_group_col} IS NOT NULL
              AND {micro_dist_col} IS NOT NULL
            {canton_filter}{extra_filter}
            """,
            [paths.microcensus_trips, paths.microcensus_persons],
        ).fetchall()
        for cid, grp, dist in rows:
            _append(int(cid), str(grp), float(dist), "Microcensus")

    if "Synthetic" in sources:
        rows = con.execute(
            f"""
            SELECT p.canton_id,
                   {synth_group_col}  AS grp,
                   {synth_dist_col}   AS dist
            FROM read_parquet(?) t
            INNER JOIN read_parquet(?) p
                ON TRY_CAST(t.person AS BIGINT) = p.person_id
            WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
              AND p.canton_id IS NOT NULL
              AND {synth_group_col} IS NOT NULL
              AND {synth_dist_col} IS NOT NULL
            {canton_filter}{extra_filter}
            """,
            [paths.synthetic_output_trips, paths.synthetic_persons],
        ).fetchall()
        for cid, grp, dist in rows:
            _append(int(cid), str(grp), float(dist), "Synthetic")

    return result


# ---------------------------------------------------------------------------
# Histogram computation
# ---------------------------------------------------------------------------

def _compute_histogram(values: list[float], bin_width: float, num_bins: int):
    """Return (percentages, mean, sample_size) for a list of distance values.

    ``percentages`` is a list of length ``num_bins`` where each entry is
    the percentage of values falling into that bin.
    """
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


# ---------------------------------------------------------------------------
# Base provider for all histogram endpoints
# ---------------------------------------------------------------------------

class HistogramDistanceProvider(DataProvider):
    """Abstract base for histogram-of-distance providers.

    Subclasses must set:
      ROUTE         – the JSON filename / URL segment
      DISTANCE_TYPE – ``"euclidean"`` or ``"network"``
      GROUP_COL     – ``"mode"`` or ``"purpose"``
    """

    DISTANCE_TYPE: str
    GROUP_COL: str

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")

        # Build the appropriate group filter
        if self.GROUP_COL == "mode":
            gf_micro = mode_filter_sql(params, "t.mode")
            gf_synth = mode_filter_sql(params, "t.main_mode")
        else:
            gf_micro = purpose_filter_sql(params, "t.purpose")
            gf_synth = purpose_filter_sql(params, "t.end_activity_type")

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

        # We need source-specific extra filters because columns differ
        # Load each source separately so we can apply correct column filters
        raw: dict[int | str, list[tuple[str, float, str]]] = {}

        if "Microcensus" in sources:
            micro_data = load_distance_data(
                con, paths, ["Microcensus"],
                self.DISTANCE_TYPE, self.GROUP_COL,
                canton_filter=cf, extra_filter=gf_micro,
            )
            for key, rows in micro_data.items():
                raw.setdefault(key, []).extend(rows)

        if "Synthetic" in sources:
            synth_data = load_distance_data(
                con, paths, ["Synthetic"],
                self.DISTANCE_TYPE, self.GROUP_COL,
                canton_filter=cf, extra_filter=gf_synth,
            )
            for key, rows in synth_data.items():
                raw.setdefault(key, []).extend(rows)

        # Determine all cantons that appeared (excluding "All")
        seen_cantons = {k for k in raw if k != "All"}
        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        result: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            entries = raw.get(cid, [])
            if not entries:
                continue

            # Group entries by group_value
            by_group: dict[str, dict[str, list[float]]] = {}
            for grp, dist, src in entries:
                by_group.setdefault(grp, {}).setdefault(src, []).append(dist)

            canton_result: dict = {}
            for grp in sorted(by_group):
                source_dists = by_group[grp]

                # Merge all distances to find the combined max
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

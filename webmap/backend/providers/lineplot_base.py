"""Shared helper for all lineplot providers.

Builds binned lineplot data from raw (canton_id, group_value, variable_value)
rows, producing the JSON structure expected by the frontend.
"""

from __future__ import annotations

import math
from collections import defaultdict

from .constants import canton_name
from .helpers import build_canton_lookup


# ---------------------------------------------------------------------------
# Tick-label generators
# ---------------------------------------------------------------------------

def _departure_time_ticks(max_value: float) -> tuple[list[str], list[float]]:
    """Return (tick_labels, tick_vals) for departure-time lineplots.

    Ticks every 2 hours, labelled as 12-hour AM/PM strings.
    """
    tick_vals: list[float] = []
    tick_labels: list[str] = []
    v = 0.0
    while v <= max_value + 1e-9:
        tick_vals.append(v)
        hour = int(v) % 24
        if hour == 0:
            tick_labels.append("12:00 AM")
        elif hour < 12:
            tick_labels.append(f"{hour:02d}:00 AM")
        elif hour == 12:
            tick_labels.append("12:00 PM")
        else:
            tick_labels.append(f"{hour - 12:02d}:00 PM")
        v += 2.0
    return tick_labels, tick_vals


def _distance_ticks(max_value: float) -> tuple[list[str], list[float]]:
    """Return (tick_labels, tick_vals) for distance lineplots.

    Chooses a sensible tick spacing and labels as "X km".
    """
    # Pick a nice step so we get roughly 10-11 ticks
    raw_step = max_value / 10
    # Round step to a nice number
    magnitude = 10 ** math.floor(math.log10(raw_step)) if raw_step > 0 else 1
    nice_steps = [1, 2, 5, 10]
    step = magnitude
    for ns in nice_steps:
        candidate = ns * magnitude
        if candidate >= raw_step:
            step = candidate
            break

    tick_vals: list[float] = []
    tick_labels: list[str] = []
    v = 0.0
    while v <= max_value + 1e-9:
        tick_vals.append(v)
        tick_labels.append(f"{int(v)} km")
        v += step
    return tick_labels, tick_vals


# ---------------------------------------------------------------------------
# Core binning logic
# ---------------------------------------------------------------------------

def build_lineplot(
    *,
    microcensus_rows: list[tuple] | None,
    synthetic_rows: list[tuple] | None,
    group_key: str,
    num_bins: int,
    max_value: float | None,
    tick_fn: str,
) -> dict:
    """Build the lineplot JSON structure.

    Each source's *rows* must be an iterable of
        (canton_id: int, group_value: str, variable_value: float)

    Parameters
    ----------
    microcensus_rows : rows from the microcensus source (or None)
    synthetic_rows   : rows from the synthetic source (or None)
    group_key        : JSON key name for the grouping variable ("mode" or "purpose")
    num_bins         : number of bins
    max_value        : upper bound of binning range. If None, auto-computed
                       from the 95th percentile of all data.
    tick_fn          : "departure_time" or "distance" — selects the tick
                       label generator
    """
    # Collect all variable values to auto-compute max_value if needed
    all_values: list[float] = []
    source_map: dict[str, list[tuple]] = {}
    if microcensus_rows is not None:
        source_map["microcensus"] = microcensus_rows
        all_values.extend(v for _, _, v in microcensus_rows)
    if synthetic_rows is not None:
        source_map["synthetic"] = synthetic_rows
        all_values.extend(v for _, _, v in synthetic_rows)

    if not all_values:
        return {}

    if max_value is None:
        all_values_sorted = sorted(all_values)
        idx = int(len(all_values_sorted) * 0.95)
        max_value = float(all_values_sorted[min(idx, len(all_values_sorted) - 1)])
        # Round up to a nice number
        max_value = float(math.ceil(max_value))

    bin_width = max_value / num_bins

    # ---- accumulate counts: (source, canton_or_All, bin_index, group_value) -> count
    counts: dict[tuple, float] = defaultdict(float)
    # total per (source, canton_or_All, bin_index) for percentage computation
    bin_totals: dict[tuple, float] = defaultdict(float)
    seen_cantons: set[int] = set()
    seen_groups: set[str] = set()

    for source_name, rows in source_map.items():
        for cid, group_val, var_val in rows:
            cid = int(cid)
            group_val = str(group_val)
            if var_val < 0 or var_val >= max_value:
                # Clamp: values >= max_value go into last bin
                if var_val >= max_value:
                    bi = num_bins - 1
                else:
                    continue
            else:
                bi = int(var_val / bin_width)
                if bi >= num_bins:
                    bi = num_bins - 1

            seen_cantons.add(cid)
            seen_groups.add(group_val)

            for c in (cid, "All"):
                counts[(source_name, c, bi, group_val)] += 1.0
                bin_totals[(source_name, c, bi)] += 1.0

    canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
    sorted_groups = sorted(seen_groups)

    # ---- build bin labels
    bin_labels: list[str] = []
    bin_midpoints: list[float] = []
    for bi in range(num_bins):
        lo = bi * bin_width
        hi = (bi + 1) * bin_width
        bin_labels.append(f"{lo:.1f}-{hi:.1f}")
        bin_midpoints.append((lo + hi) / 2.0)

    # ---- tick labels
    if tick_fn == "departure_time":
        tick_labels, tick_vals = _departure_time_ticks(max_value)
    else:
        tick_labels, tick_vals = _distance_ticks(max_value)

    # ---- assemble result
    result: dict = {}
    for cname in ["All"] + canton_names:
        cid = canton_ids_by_name.get(cname, "All")
        canton_block: dict = {}

        for source_name in source_map:
            records: list[dict] = []
            for bi in range(num_bins):
                bt = bin_totals.get((source_name, cid, bi), 0.0)
                for gv in sorted_groups:
                    cnt = counts.get((source_name, cid, bi, gv), 0.0)
                    pct = (cnt / bt * 100.0) if bt > 0 else 0.0
                    records.append({
                        "variable_bin": bin_labels[bi],
                        group_key: gv,
                        "count": cnt,
                        "percentage": pct,
                        "variable_midpoint": bin_midpoints[bi],
                    })
            canton_block[source_name] = records

        canton_block["tick_labels"] = tick_labels
        canton_block["tick_vals"] = tick_vals
        canton_block["max_value"] = max_value

        result[cname] = canton_block

    return result

"""Shared helper for lineplot providers — polygon-aware version.

Builds binned lineplot data from raw (label, group_value, variable_value)
rows. The label is the human-readable polygon name (e.g., "Zurich") or
``"All"`` for the rollup.
"""

from __future__ import annotations

import math
from collections import defaultdict


def _departure_time_ticks(max_value: float):
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


def _distance_ticks(max_value: float):
    raw_step = max_value / 10
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


def build_lineplot(
    *,
    microcensus_rows=None,
    synthetic_rows=None,
    group_key: str,
    num_bins: int,
    max_value: float | None,
    tick_fn: str,
    summary_only: bool = False,
):
    """Build the lineplot JSON structure.

    Each source's *rows* must be an iterable of
        (label: str, group_value: str, variable_value: float)
    where ``label`` is the polygon's display name (e.g. "Zurich") or
    "All" for the rollup. The "All" rollup is added by this function.
    """
    all_values: list[float] = []
    source_map: dict[str, list[tuple]] = {}
    if microcensus_rows is not None:
        source_map["microcensus"] = list(microcensus_rows)
        all_values.extend(v for _, _, v in source_map["microcensus"])
    if synthetic_rows is not None:
        source_map["synthetic"] = list(synthetic_rows)
        all_values.extend(v for _, _, v in source_map["synthetic"])
    if not all_values:
        return {}

    if max_value is None:
        all_sorted = sorted(all_values)
        idx = int(len(all_sorted) * 0.95)
        max_value = float(math.ceil(all_sorted[min(idx, len(all_sorted) - 1)]))
    bin_width = max_value / num_bins

    counts: dict[tuple, float] = defaultdict(float)
    bin_totals: dict[tuple, float] = defaultdict(float)
    seen_labels: set = set()
    seen_groups: set = set()

    for source_name, rows in source_map.items():
        for label, group_val, var_val in rows:
            label = str(label); group_val = str(group_val)
            if var_val < 0:
                continue
            if var_val >= max_value:
                bi = num_bins - 1
            else:
                bi = int(var_val / bin_width)
                if bi >= num_bins:
                    bi = num_bins - 1
            seen_groups.add(group_val)
            if summary_only:
                counts[(source_name, "All", bi, group_val)] += 1.0
                bin_totals[(source_name, "All", bi)] += 1.0
            else:
                seen_labels.add(label)
                for lbl in (label, "All"):
                    counts[(source_name, lbl, bi, group_val)] += 1.0
                    bin_totals[(source_name, lbl, bi)] += 1.0

    sorted_groups = sorted(seen_groups)
    bin_labels = []; bin_midpoints = []
    for bi in range(num_bins):
        lo = bi * bin_width; hi = (bi + 1) * bin_width
        bin_labels.append(f"{lo:.1f}-{hi:.1f}")
        bin_midpoints.append((lo + hi) / 2.0)

    if tick_fn == "departure_time":
        tick_labels, tick_vals = _departure_time_ticks(max_value)
    else:
        tick_labels, tick_vals = _distance_ticks(max_value)

    result: dict = {}
    label_list = ["All"] if summary_only else ["All"] + sorted(seen_labels)
    for label in label_list:
        block: dict = {}
        for source_name in source_map:
            records = []
            for bi in range(num_bins):
                bt = bin_totals.get((source_name, label, bi), 0.0)
                for gv in sorted_groups:
                    cnt = counts.get((source_name, label, bi, gv), 0.0)
                    pct = (cnt / bt * 100.0) if bt > 0 else 0.0
                    records.append({
                        "variable_bin": bin_labels[bi],
                        group_key: gv,
                        "count": cnt,
                        "percentage": pct,
                        "variable_midpoint": bin_midpoints[bi],
                    })
            block[source_name] = records
        block["tick_labels"] = tick_labels
        block["tick_vals"] = tick_vals
        block["max_value"] = max_value
        result[label] = block
    return result

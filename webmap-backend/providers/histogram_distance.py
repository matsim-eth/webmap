"""Distance histogram per polygon, grouped by mode or purpose.

Always raw scan (we need the raw values to bucket them). With the R-tree
spatial index on persons.home_pt and the indexed JOIN onto hot_polygons,
this is fast enough at 10M scale.
"""

from __future__ import annotations

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
from ._pre_agg import label_for, polygon_filter_clause, make_label_resolver, resolve_polygon_ids, _source_label


_DIST_COLS = {
    "euclidean": "t.crowfly_distance",
    "network":   "t.network_distance",
}


def _compute_hist(values, bin_width, total_bins):
    n = len(values)
    if n == 0:
        return [0.0] * total_bins, 0.0, 0
    counts = [0] * total_bins
    total = 0.0
    for v in values:
        idx = int(v / bin_width) if bin_width > 0 else 0
        if idx >= total_bins:
            idx = total_bins - 1
        counts[idx] += 1
        total += v
    return [(c / n) * 100.0 for c in counts], total / n, n


def _quantile(sorted_vals, q):
    if not sorted_vals:
        return 0.0
    idx = q * (len(sorted_vals) - 1)
    lo = int(idx); hi = min(lo + 1, len(sorted_vals) - 1)
    frac = idx - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


class HistogramDistanceProvider(DataProvider):
    ROUTE = "histogram_distance.json"
    PARAMS = TRIP_FILTERS + [
        SUMMARY_ONLY,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("distance_type", "Distance metric", enum=["euclidean", "network"]),
        Param("group_by", "Group results by 'mode' (default) or 'purpose'", enum=["mode", "purpose"]),
        Param("num_bins", "Number of IQR-range bins (default 25)", param_type="integer"),
        Param("max_iqr", "IQR multiplier for range (default 3)", param_type="number"),
        Param("max_distance", "Cap maximum distance for binning", param_type="number"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        summary = is_summary_only(params) and not params.get("canton") and not params.get("polygon_id") and not has_person_filters(params)
        distance_type = (params.get("distance_type") or "euclidean").lower()
        if distance_type not in _DIST_COLS:
            distance_type = "euclidean"
        group_by = (params.get("group_by") or "mode").lower()
        if group_by not in ("mode", "purpose"):
            group_by = "mode"
        dist_col = _DIST_COLS[distance_type]
        grp_col = "t.main_mode" if group_by == "mode" else "t.following_purpose"

        try:
            num_bins = int(params.get("num_bins", 25))
        except ValueError:
            num_bins = 25
        try:
            max_iqr = float(params.get("max_iqr", 3))
        except (ValueError, TypeError):
            max_iqr = 3.0
        max_distance_cap = None
        if params.get("max_distance"):
            try:
                max_distance_cap = float(params["max_distance"])
            except ValueError:
                max_distance_cap = None

        gf = "" if summary else gender_filter_sql(params, "p.sex")
        af = "" if summary else age_filter_sql(params, "p.age")
        mf = mode_filter_sql(params, "t.main_mode")
        pf = purpose_filter_sql(params, "t.following_purpose")
        person_join_needed = bool(gf or af or not summary)

        con0 = get_source_cursor(sources[0])
        polygon_ids = [] if summary else resolve_polygon_ids(con0, params, default_type="canton")

        # raw[(label, group, source)] = [distances]
        raw: dict[tuple[str, str, str], list[float]] = {}

        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            slabel = _source_label(source)

            # Per-polygon
            if polygon_ids:
                join, where, group_expr, bind, _ = polygon_filter_clause(polygon_ids)
                resolve = make_label_resolver(con, polygon_ids,
                                               all(p.startswith("canton:") for p in polygon_ids))
                rows = con.execute(f"""
                    SELECT {group_expr} AS poly_key, {grp_col} AS grp, {dist_col} AS dist
                    FROM trips t
                    JOIN persons p ON p.person_id = t.person_id
                    {join}
                    WHERE {grp_col} IS NOT NULL AND {dist_col} IS NOT NULL
                    {where}{gf}{af}{mf}{pf}
                """, bind).fetchall()
                for poly_key, grp, dist in rows:
                    label = resolve(poly_key)
                    raw.setdefault((label, str(grp), slabel), []).append(float(dist))

            # "All" rollup
            join = "JOIN persons p ON p.person_id = t.person_id" if person_join_needed else ""
            rows_all = con.execute(f"""
                SELECT {grp_col} AS grp, {dist_col} AS dist
                FROM trips t
                {join}
                WHERE {grp_col} IS NOT NULL AND {dist_col} IS NOT NULL
                {gf}{af}{mf}{pf}
            """).fetchall()
            for grp, dist in rows_all:
                raw.setdefault(("All", str(grp), slabel), []).append(float(dist))

        # Reorganize: result[label][group] = {bins, hists, ...}
        result: dict = {}
        labels = sorted({k[0] for k in raw.keys()})
        for label in labels:
            label_groups = sorted({k[1] for k in raw.keys() if k[0] == label})
            label_result: dict = {}
            for grp in label_groups:
                synth_vals = sorted(raw.get((label, grp, "Synthetic"), []))
                micro_vals = raw.get((label, grp, "Microcensus"), [])
                if not synth_vals and not micro_vals:
                    continue
                if synth_vals:
                    q1 = _quantile(synth_vals, 0.25); q3 = _quantile(synth_vals, 0.75)
                    range_max = q3 + max_iqr * (q3 - q1)
                    bin_width = range_max / num_bins if range_max > 0 else 1.0
                else:
                    max_dist = max(micro_vals)
                    bin_width = max_dist / num_bins if max_dist > 0 else 1.0
                if bin_width <= 0:
                    continue
                all_max = max(max(synth_vals) if synth_vals else 0, max(micro_vals) if micro_vals else 0)
                if max_distance_cap and max_distance_cap > 0:
                    all_max = min(all_max, max_distance_cap)
                total_bins = max(num_bins, int(all_max / bin_width) + 1)
                bins = [round(i * bin_width, 2) for i in range(total_bins + 1)]
                m_hist, m_mean, m_n = _compute_hist(micro_vals, bin_width, total_bins)
                s_hist, s_mean, s_n = _compute_hist(synth_vals, bin_width, total_bins)
                label_result[grp] = {
                    "bin_width": bin_width,
                    "bins": bins,
                    "microcensus_histogram": m_hist,
                    "synthetic_histogram": s_hist,
                    "microcensus_mean": round(m_mean, 6),
                    "synthetic_mean": round(s_mean, 6),
                    "microcensus_sample_size": m_n,
                    "synthetic_sample_size": s_n,
                }
            if label_result:
                result[label] = label_result
        return result

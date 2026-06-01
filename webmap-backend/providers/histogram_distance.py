"""Distance histogram per polygon, grouped by mode or purpose.

Two SQL passes keep memory flat at country scale (never one Python row per
trip):

  1. **Aggregates** — per (polygon, group, source): count, mean, q1, q3, max
     via ``quantile_cont``. From these we derive each group's IQR-based bin
     width and bin count (exactly as the legacy code did from the raw sorted
     values).
  2. **Bin counts** — the per-group bin width/count are fed back as a small
     ``VALUES`` table and joined, so DuckDB buckets the trips with
     ``FLOOR(dist / bin_width)`` and returns only the bounded
     (polygon × group × bin) counts.

Output is identical to the previous raw-fetch implementation.
"""

from __future__ import annotations

from .base import DataProvider, Param, TRIP_FILTERS, SUMMARY_ONLY
from .connection import get_source_cursor
from .helpers import (
    age_filter_sql,
    gender_filter_sql,
    has_person_filters,
    is_summary_only,
    mode_filter_sql,
    parse_source_param,
    purpose_filter_sql,
)
from ._pre_agg import make_label_resolver, polygon_filter_clause, resolve_polygon_ids, _source_label


_DIST_COLS = {
    "euclidean": "t.crowfly_distance",
    "network":   "t.network_distance",
}


def _sql_str(v) -> str:
    """Escape a value for inline use in a VALUES literal."""
    return "'" + str(v).replace("'", "''") + "'"


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

        base_where = f"{grp_col} IS NOT NULL AND {dist_col} IS NOT NULL"

        # agg[(label, grp, slabel)] = {"n":, "mean":, "q1":, "q3":, "mx":}
        agg: dict[tuple[str, str, str], dict] = {}
        # gkeys[(label, grp, source)] = raw SQL group key (for the bin-count pass)
        gkeys: dict[tuple[str, str, str], object] = {}

        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            slabel = _source_label(source)

            # ── Pass 1: aggregates ──────────────────────────────────────────
            if polygon_ids:
                join, where, group_expr, bind, _ = polygon_filter_clause(polygon_ids)
                resolve = make_label_resolver(con, polygon_ids,
                                               all(p.startswith("canton:") for p in polygon_ids))
                rows = con.execute(f"""
                    SELECT {group_expr} AS gkey, {grp_col} AS grp,
                           count(*) AS n, avg({dist_col}) AS mean,
                           quantile_cont({dist_col}, 0.25) AS q1,
                           quantile_cont({dist_col}, 0.75) AS q3,
                           max({dist_col}) AS mx
                    FROM trips t JOIN persons p ON p.person_id = t.person_id
                    {join}
                    WHERE {base_where} {where}{gf}{af}{mf}{pf}
                    GROUP BY {group_expr}, {grp_col}
                """, bind).fetchall()
                for gkey, grp, n, mean, q1, q3, mx in rows:
                    label = resolve(gkey)
                    k = (label, str(grp), slabel)
                    agg[k] = {"n": n, "mean": mean, "q1": q1, "q3": q3, "mx": mx}
                    gkeys[(label, str(grp), source)] = gkey

            join_all = "JOIN persons p ON p.person_id = t.person_id" if person_join_needed else ""
            rows_all = con.execute(f"""
                SELECT {grp_col} AS grp, count(*) AS n, avg({dist_col}) AS mean,
                       quantile_cont({dist_col}, 0.25) AS q1,
                       quantile_cont({dist_col}, 0.75) AS q3,
                       max({dist_col}) AS mx
                FROM trips t {join_all}
                WHERE {base_where} {gf}{af}{mf}{pf}
                GROUP BY {grp_col}
            """).fetchall()
            for grp, n, mean, q1, q3, mx in rows_all:
                agg[("All", str(grp), slabel)] = {"n": n, "mean": mean, "q1": q1, "q3": q3, "mx": mx}

        # ── Derive per (label, grp) bin width / count (legacy formulas) ──────
        # binparams[(label, grp)] = (bin_width, total_bins, bins)
        binparams: dict[tuple[str, str], tuple] = {}
        labels = sorted({k[0] for k in agg.keys()})
        for label in labels:
            for grp in sorted({k[1] for k in agg.keys() if k[0] == label}):
                s = agg.get((label, grp, "Synthetic"))
                m = agg.get((label, grp, "Microcensus"))
                if not s and not m:
                    continue
                if s:
                    q1, q3 = s["q1"], s["q3"]
                    range_max = q3 + max_iqr * (q3 - q1)
                    bin_width = range_max / num_bins if range_max > 0 else 1.0
                else:
                    bin_width = (m["mx"] / num_bins) if (m and m["mx"] and m["mx"] > 0) else 1.0
                if bin_width <= 0:
                    continue
                all_max = max(s["mx"] if s else 0, m["mx"] if m else 0)
                if max_distance_cap and max_distance_cap > 0:
                    all_max = min(all_max, max_distance_cap)
                total_bins = max(num_bins, int(all_max / bin_width) + 1)
                bins = [round(i * bin_width, 2) for i in range(total_bins + 1)]
                binparams[(label, grp)] = (bin_width, total_bins, bins)

        # ── Pass 2: bin counts via VALUES join (per source) ─────────────────
        # histcounts[(label, grp, slabel)] = {bin_index: count}
        histcounts: dict[tuple[str, str, str], dict] = {}
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            slabel = _source_label(source)

            # Per-polygon
            if polygon_ids:
                join, where, group_expr, bind, _ = polygon_filter_clause(polygon_ids)
                vals = []
                for (label, grp), (bw, tb, _b) in binparams.items():
                    if label == "All":
                        continue
                    gk = gkeys.get((label, grp, source))
                    if gk is None:
                        continue
                    gk_lit = gk if isinstance(gk, (int, float)) else _sql_str(gk)
                    vals.append(f"({gk_lit}, {_sql_str(grp)}, {bw}, {tb})")
                if vals:
                    values_sql = ", ".join(vals)
                    rows = con.execute(f"""
                        WITH w(gkey, grp, bw, tb) AS (VALUES {values_sql})
                        SELECT {group_expr} AS gkey, {grp_col} AS grp,
                               LEAST(CAST(FLOOR({dist_col} / w.bw) AS INTEGER), w.tb - 1) AS bin,
                               count(*) AS c
                        FROM trips t JOIN persons p ON p.person_id = t.person_id
                        {join}
                        JOIN w ON w.gkey = {group_expr} AND w.grp = {grp_col}
                        WHERE {base_where} {where}{gf}{af}{mf}{pf}
                        GROUP BY {group_expr}, {grp_col}, bin
                    """, bind).fetchall()
                    resolve = make_label_resolver(con, polygon_ids,
                                                   all(p.startswith("canton:") for p in polygon_ids))
                    for gkey, grp, b, c in rows:
                        histcounts.setdefault((resolve(gkey), str(grp), slabel), {})[b] = c

            # "All" rollup
            all_vals = []
            for (label, grp), (bw, tb, _b) in binparams.items():
                if label != "All":
                    continue
                all_vals.append(f"({_sql_str(grp)}, {bw}, {tb})")
            if all_vals:
                values_sql = ", ".join(all_vals)
                join_all = "JOIN persons p ON p.person_id = t.person_id" if person_join_needed else ""
                rows = con.execute(f"""
                    WITH w(grp, bw, tb) AS (VALUES {values_sql})
                    SELECT {grp_col} AS grp,
                           LEAST(CAST(FLOOR({dist_col} / w.bw) AS INTEGER), w.tb - 1) AS bin,
                           count(*) AS c
                    FROM trips t {join_all}
                    JOIN w ON w.grp = {grp_col}
                    WHERE {base_where} {gf}{af}{mf}{pf}
                    GROUP BY {grp_col}, bin
                """).fetchall()
                for grp, b, c in rows:
                    histcounts.setdefault(("All", str(grp), slabel), {})[b] = c

        # ── Assemble output ─────────────────────────────────────────────────
        def _hist(counts: dict, total_bins: int, n: int):
            if not n:
                return [0.0] * total_bins
            return [(counts.get(b, 0) / n) * 100.0 for b in range(total_bins)]

        result: dict = {}
        for label in labels:
            label_result: dict = {}
            for grp in sorted({k[1] for k in agg.keys() if k[0] == label}):
                if (label, grp) not in binparams:
                    continue
                bin_width, total_bins, bins = binparams[(label, grp)]
                s = agg.get((label, grp, "Synthetic"))
                m = agg.get((label, grp, "Microcensus"))
                s_n = s["n"] if s else 0
                m_n = m["n"] if m else 0
                s_hist = _hist(histcounts.get((label, grp, "Synthetic"), {}), total_bins, s_n)
                m_hist = _hist(histcounts.get((label, grp, "Microcensus"), {}), total_bins, m_n)
                label_result[grp] = {
                    "bin_width": bin_width,
                    "bins": bins,
                    "microcensus_histogram": m_hist,
                    "synthetic_histogram": s_hist,
                    "microcensus_mean": round(m["mean"], 6) if m and m["mean"] is not None else 0.0,
                    "synthetic_mean": round(s["mean"], 6) if s and s["mean"] is not None else 0.0,
                    "microcensus_sample_size": m_n,
                    "synthetic_sample_size": s_n,
                }
            if label_result:
                result[label] = label_result
        return result

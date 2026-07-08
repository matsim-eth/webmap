"""Lineplot — departure time / distance distributions per polygon.

Binning is pushed into DuckDB (``GROUPING SETS`` for the per-polygon and
"All" rollup in a single scan), so only the bounded (label × group × bin)
aggregates ever reach Python — never one row per trip. This keeps memory
flat as the population grows to country scale.

The one case that still needs raw values is a distance metric with no
explicit ``max_value`` AND more than one source, because the original
upper bound is the 95th-percentile of the *combined* multi-file value
multiset; that rare combination falls back to the legacy raw-row path
(:func:`build_lineplot`) to stay byte-for-byte identical. The common
single-source case computes the same percentile with a RAM-safe
order-statistic query.
"""

from __future__ import annotations

import math

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
from ._pre_agg import make_label_resolver, polygon_filter_clause, primary_fast_path, resolve_polygon_ids
from .lineplot_base import assemble_from_counts, build_lineplot


_METRIC_CONFIG = {
    "departure_time": {
        "value_expr":      "t.departure_time / 3600.0",
        "value_null_check": "t.departure_time",
        "tick_fn": "departure_time",
        "default_max": 30.0,
    },
    "euclidean_distance": {
        "value_expr":      "t.crowfly_distance / 1000.0",
        "value_null_check": "t.crowfly_distance",
        "tick_fn": "distance",
        "default_max": None,
    },
    "network_distance": {
        "value_expr":      "t.network_distance / 1000.0",
        "value_null_check": "t.network_distance",
        "tick_fn": "distance",
        "default_max": None,
    },
}


class LineplotProvider(DataProvider):
    ROUTE = "lineplot.json"
    PARAMS = TRIP_FILTERS + [
        SUMMARY_ONLY,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("metric", "Value to plot", enum=["departure_time", "euclidean_distance", "network_distance"]),
        Param("group_by", "Group results by 'mode' (default) or 'purpose'", enum=["mode", "purpose"]),
        Param("num_bins", "Number of bins (default 32)", param_type="integer"),
        Param("max_value", "Upper bound (hours for time, km for distance)", param_type="number"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        summary = is_summary_only(params) and not (params.get("canton") or params.get("zone") or params.get("polygon_id")) and not has_person_filters(params)
        gf = "" if summary else gender_filter_sql(params, "p.sex")
        af = "" if summary else age_filter_sql(params, "p.age")
        mf = mode_filter_sql(params, "t.main_mode")
        pf = purpose_filter_sql(params, "t.following_purpose")

        metric = (params.get("metric") or "departure_time").lower()
        if metric not in _METRIC_CONFIG:
            metric = "departure_time"
        cfg = _METRIC_CONFIG[metric]
        value_expr = cfg["value_expr"]
        null_check = cfg["value_null_check"]
        group_by = (params.get("group_by") or "mode").lower()
        if group_by not in ("mode", "purpose"):
            group_by = "mode"
        grp_col = "t.main_mode" if group_by == "mode" else "t.following_purpose"

        try:
            num_bins = int(params.get("num_bins", 32))
        except ValueError:
            num_bins = 32
        max_value = cfg["default_max"]
        if params.get("max_value"):
            try:
                max_value = float(params["max_value"])
            except ValueError:
                pass

        con0 = get_source_cursor(sources[0])
        polygon_ids = [] if summary else resolve_polygon_ids(con0, params, default_type="canton")
        use_polygon = bool(polygon_ids)

        # The combined-multi-source percentile (no max_value, distance metric)
        # needs the raw multiset; keep the exact legacy path for that case only.
        if max_value is None and len(sources) > 1:
            return self._legacy(
                sources, value_expr, null_check, grp_col, group_by,
                num_bins, gf, af, mf, pf, polygon_ids, use_polygon, summary, cfg,
            )

        base_where = f"{grp_col} IS NOT NULL AND {null_check} IS NOT NULL"

        # ── Determine max_value (single-source 95th percentile if unset) ──────
        if max_value is None:
            con = get_source_cursor(sources[0])
            if use_polygon:
                join, where, _, bind, _ = polygon_filter_clause(polygon_ids)
                from_sql = f"FROM trips t JOIN persons p ON p.person_id = t.person_id {join}"
                where_sql = f"WHERE {base_where} {where}{gf}{af}{mf}{pf}"
            else:
                join = "JOIN persons p ON p.person_id = t.person_id" if (gf or af) else ""
                from_sql = f"FROM trips t {join}"
                where_sql = f"WHERE {base_where} {gf}{af}{mf}{pf}"
                bind = []
            row = con.execute(f"""
                WITH v AS (SELECT {value_expr} AS val {from_sql} {where_sql}),
                     o AS (SELECT val,
                                  row_number() OVER (ORDER BY val) - 1 AS rn,
                                  count(*) OVER () AS n
                           FROM v)
                SELECT val FROM o WHERE rn = LEAST(CAST(FLOOR(n * 0.95) AS INTEGER), n - 1)
            """, bind).fetchone()
            if not row or row[0] is None:
                return {}
            max_value = float(math.ceil(row[0]))

        bin_width = max_value / num_bins if num_bins else max_value
        if bin_width <= 0:
            return {}
        # NB: DuckDB CAST(x AS INTEGER) rounds; Python int() truncates. Use
        # FLOOR to replicate int(val / bin_width) exactly (values are >= 0).
        bin_expr = f"LEAST(CAST(FLOOR({value_expr} / {bin_width}) AS INTEGER), {num_bins - 1})"

        counts: dict = {}
        bin_totals: dict = {}
        seen_labels: set = set()
        seen_groups: set = set()
        source_names: list = []

        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            target = "microcensus" if source == "microcensus" else "synthetic"
            source_names.append(target)

            if use_polygon:
                join, where, group_expr, bind, _ = polygon_filter_clause(polygon_ids)
                resolve = make_label_resolver(
                    con, polygon_ids, primary_fast_path(polygon_ids)
                )
                rows = con.execute(f"""
                    SELECT {group_expr} AS lbl, {grp_col} AS grp, {bin_expr} AS bin, count(*) AS c
                    FROM trips t JOIN persons p ON p.person_id = t.person_id
                    {join}
                    WHERE {base_where} AND {value_expr} >= 0 {where}{gf}{af}{mf}{pf}
                    GROUP BY GROUPING SETS (({group_expr}, {grp_col}, {bin_expr}), ({grp_col}, {bin_expr}))
                """, bind).fetchall()
                for lbl, grp, bi, c in rows:
                    grp = str(grp)
                    seen_groups.add(grp)
                    if lbl is None:
                        label = "All"
                    else:
                        label = resolve(lbl)
                        seen_labels.add(label)
                    counts[(target, label, bi, grp)] = counts.get((target, label, bi, grp), 0.0) + c
                    bin_totals[(target, label, bi)] = bin_totals.get((target, label, bi), 0.0) + c
            else:
                join = "JOIN persons p ON p.person_id = t.person_id" if (gf or af) else ""
                rows = con.execute(f"""
                    SELECT {grp_col} AS grp, {bin_expr} AS bin, count(*) AS c
                    FROM trips t {join}
                    WHERE {base_where} AND {value_expr} >= 0 {gf}{af}{mf}{pf}
                    GROUP BY {grp_col}, {bin_expr}
                """).fetchall()
                for grp, bi, c in rows:
                    grp = str(grp)
                    seen_groups.add(grp)
                    counts[(target, "All", bi, grp)] = counts.get((target, "All", bi, grp), 0.0) + c
                    bin_totals[(target, "All", bi)] = bin_totals.get((target, "All", bi), 0.0) + c

        if not source_names:
            return {}

        return assemble_from_counts(
            counts=counts,
            bin_totals=bin_totals,
            source_names=source_names,
            seen_labels=seen_labels,
            seen_groups=seen_groups,
            group_key=group_by,
            num_bins=num_bins,
            bin_width=bin_width,
            max_value=max_value,
            tick_fn=cfg["tick_fn"],
            summary_only=summary,
        )

    # ── Legacy raw-row path (exact parity) for multi-source + no max_value ────
    def _legacy(self, sources, value_expr, null_check, grp_col, group_by,
                num_bins, gf, af, mf, pf, polygon_ids, use_polygon, summary, cfg):
        rows_by_source: dict[str, list[tuple]] = {"synthetic": [], "microcensus": []}
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            target = "microcensus" if source == "microcensus" else "synthetic"
            if use_polygon:
                join, where, group_expr, bind, _ = polygon_filter_clause(polygon_ids)
                resolve = make_label_resolver(
                    con, polygon_ids, primary_fast_path(polygon_ids)
                )
                rows = con.execute(f"""
                    SELECT {group_expr} AS poly_key, {grp_col} AS grp, {value_expr} AS val
                    FROM trips t JOIN persons p ON p.person_id = t.person_id
                    {join}
                    WHERE {grp_col} IS NOT NULL AND {null_check} IS NOT NULL
                    {where}{gf}{af}{mf}{pf}
                """, bind).fetchall()
                for poly_key, grp, val in rows:
                    rows_by_source[target].append((resolve(poly_key), str(grp), float(val)))
            else:
                join = "JOIN persons p ON p.person_id = t.person_id" if (gf or af) else ""
                rows = con.execute(f"""
                    SELECT {grp_col}, {value_expr}
                    FROM trips t {join}
                    WHERE {grp_col} IS NOT NULL AND {null_check} IS NOT NULL
                    {gf}{af}{mf}{pf}
                """).fetchall()
                for grp, val in rows:
                    rows_by_source[target].append(("All", str(grp), float(val)))

        return build_lineplot(
            microcensus_rows=rows_by_source["microcensus"] if "microcensus" in sources else None,
            synthetic_rows=rows_by_source["synthetic"] if "synthetic" in sources else None,
            group_key=group_by,
            num_bins=num_bins,
            max_value=None,
            tick_fn=cfg["tick_fn"],
            summary_only=summary,
        )

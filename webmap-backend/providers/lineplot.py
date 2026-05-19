"""Lineplot — departure time / distance distributions per polygon."""

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
from ._pre_agg import label_for, make_label_resolver, polygon_filter_clause, resolve_polygon_ids
from .lineplot_base import build_lineplot


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
        summary = is_summary_only(params) and not (params.get("canton") or params.get("polygon_id")) and not has_person_filters(params)
        gf = "" if summary else gender_filter_sql(params, "p.sex")
        af = "" if summary else age_filter_sql(params, "p.age")
        mf = mode_filter_sql(params, "t.main_mode")
        pf = purpose_filter_sql(params, "t.following_purpose")

        metric = (params.get("metric") or "departure_time").lower()
        if metric not in _METRIC_CONFIG:
            metric = "departure_time"
        cfg = _METRIC_CONFIG[metric]
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

        # rows[source_name] = [(label, group_val, var_val), ...]
        rows_by_source: dict[str, list[tuple]] = {"synthetic": [], "microcensus": []}

        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            target = "microcensus" if source == "microcensus" else "synthetic"

            if polygon_ids:
                join, where, group_expr, bind, _ = polygon_filter_clause(polygon_ids)
                resolve = make_label_resolver(con, polygon_ids,
                                               all(p.startswith("canton:") for p in polygon_ids))
                rows = con.execute(f"""
                    SELECT {group_expr} AS poly_key, {grp_col} AS grp, {cfg['value_expr']} AS val
                    FROM trips t
                    JOIN persons p ON p.person_id = t.person_id
                    {join}
                    WHERE {grp_col} IS NOT NULL AND {cfg['value_null_check']} IS NOT NULL
                    {where}{gf}{af}{mf}{pf}
                """, bind).fetchall()
                for poly_key, grp, val in rows:
                    rows_by_source[target].append((resolve(poly_key), str(grp), float(val)))

            if summary or not polygon_ids:
                join = "JOIN persons p ON p.person_id = t.person_id" if (gf or af) else ""
                rows = con.execute(f"""
                    SELECT {grp_col}, {cfg['value_expr']}
                    FROM trips t {join}
                    WHERE {grp_col} IS NOT NULL AND {cfg['value_null_check']} IS NOT NULL
                    {gf}{af}{mf}{pf}
                """).fetchall()
                for grp, val in rows:
                    rows_by_source[target].append(("All", str(grp), float(val)))

        return build_lineplot(
            microcensus_rows=rows_by_source["microcensus"] if "microcensus" in sources else None,
            synthetic_rows=rows_by_source["synthetic"] if "synthetic" in sources else None,
            group_key=group_by,
            num_bins=num_bins,
            max_value=max_value,
            tick_fn=cfg["tick_fn"],
            summary_only=summary,
        )

"""Average trip distance, grouped by mode or purpose, per polygon.

Uses the canton_id integer column when all polygons are cantons (much
faster than ST_Within); falls back to spatial join otherwise.
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
from ._pre_agg import label_for, polygon_filter_clause, resolve_polygon_ids, _source_label


class AvgDistanceProvider(DataProvider):
    ROUTE = "avg_distance.json"
    PARAMS = TRIP_FILTERS + [
        SUMMARY_ONLY,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("group_by", "Group results by 'mode' (default) or 'purpose'", enum=["mode", "purpose"]),
        Param("min_sample_size", "Skip groups with fewer samples", param_type="integer"),
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
        group_by = (params.get("group_by") or "mode").lower()
        if group_by not in ("mode", "purpose"):
            group_by = "mode"
        try:
            min_sample = int(params.get("min_sample_size") or 0)
        except ValueError:
            min_sample = 0
        grp_col = "t.main_mode" if group_by == "mode" else "t.following_purpose"

        con0 = get_source_cursor(sources[0])
        polygon_ids = [] if summary else resolve_polygon_ids(con0, params, default_type="canton")

        result: dict = {}
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            slabel = _source_label(source)

            if polygon_ids:
                join, where, group_expr, bind, label_fn = polygon_filter_clause(polygon_ids)
                rows = con.execute(f"""
                    SELECT {group_expr} AS poly_key, {grp_col} AS grp,
                           COALESCE(SUM(t.crowfly_distance), 0) AS euc,
                           COALESCE(SUM(t.network_distance), 0) AS net,
                           COUNT(*) AS cnt
                    FROM trips t
                    JOIN persons p ON p.person_id = t.person_id
                    {join}
                    WHERE {grp_col} IS NOT NULL
                      AND t.crowfly_distance IS NOT NULL
                      AND t.network_distance IS NOT NULL
                    {where}{gf}{af}{mf}{pf}
                    GROUP BY poly_key, grp
                """, bind).fetchall()
                meta = get_hot_polygon_meta(con, polygon_ids) if not all(p.startswith("canton:") for p in polygon_ids) else None
                for poly_key, grp, euc, net, cnt in rows:
                    if cnt < min_sample:
                        continue
                    pid = label_fn(poly_key)
                    if pid.startswith("canton:"):
                        from .constants import canton_name
                        try:
                            label = canton_name(int(pid.split(":", 1)[1]))
                        except (ValueError, IndexError):
                            label = pid
                    else:
                        label = label_for(pid, meta)
                    result.setdefault(label, {}).setdefault(slabel, {})[str(grp)] = {
                        "euclidean_distance": round(float(euc) / cnt, 2),
                        "network_distance":   round(float(net) / cnt, 2),
                        "sample_size": int(cnt),
                    }

            join_p = "JOIN persons p ON p.person_id = t.person_id" if (gf or af) else ""
            rows_all = con.execute(f"""
                SELECT {grp_col}, COALESCE(SUM(t.crowfly_distance), 0),
                       COALESCE(SUM(t.network_distance), 0), COUNT(*)
                FROM trips t
                {join_p}
                WHERE {grp_col} IS NOT NULL
                  AND t.crowfly_distance IS NOT NULL
                  AND t.network_distance IS NOT NULL
                {gf}{af}{mf}{pf}
                GROUP BY 1
            """).fetchall()
            for grp, euc, net, cnt in rows_all:
                if cnt < min_sample:
                    continue
                result.setdefault("All", {}).setdefault(slabel, {})[str(grp)] = {
                    "euclidean_distance": round(float(euc) / cnt, 2),
                    "network_distance":   round(float(net) / cnt, 2),
                    "sample_size": int(cnt),
                }
        return result

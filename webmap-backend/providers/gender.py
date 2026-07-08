"""Gender distribution provider.

Backed by ``hot_polygon_demo`` for the fast path; falls back to a raw scan
of ``persons`` when an age filter is active.
"""

from __future__ import annotations

from .base import DataProvider, CANTON, SOURCE, AGE_MIN, AGE_MAX, Param
from .connection import get_source_cursor
from .helpers import (
    age_filter_sql,
    get_hot_polygon_meta,
    parse_source_param,
)
from ._pre_agg import (
    build_share_response,
    label_for,
    make_label_resolver,
    polygon_filter_clause,
    primary_fast_path,
    resolve_polygon_ids,
    _source_label,
)


COL_TO_BIN = {
    "sex_male":   "0",
    "sex_female": "1",
}


def _has_age_filter(params: dict) -> bool:
    return bool(params.get("age_min") or params.get("age_max"))


def _raw_path(sources, polygon_ids, params):
    af = age_filter_sql(params)
    out = {}
    for source in sources:
        try:
            con = get_source_cursor(source)
        except Exception:
            continue
        if polygon_ids:
            pjoin, pwhere, group_expr, pbind, _ = polygon_filter_clause(polygon_ids)
            resolve = make_label_resolver(con, polygon_ids,
                                           primary_fast_path(polygon_ids))
            sql = f"""
                SELECT {group_expr} AS poly_key, p.sex AS gender, COUNT(*) AS cnt
                FROM persons p
                {pjoin}
                WHERE p.sex IN (0, 1){pwhere}{af}
                GROUP BY poly_key, p.sex
            """
            rows = con.execute(sql, pbind).fetchall()
            per_pid: dict[str, dict[str, int]] = {}
            for poly_key, g, cnt in rows:
                label = resolve(poly_key)
                per_pid.setdefault(label, {})[str(int(g))] = cnt
            for label, vals in per_pid.items():
                denom = sum(vals.values())
                if denom == 0:
                    continue
                entry = out.setdefault(label, {}).setdefault(_source_label(source), {})
                for k in ("0", "1"):
                    v = vals.get(k, 0)
                    entry[k] = (v / denom) if denom > 0 else 0.0

        rows_all = con.execute(f"""
            SELECT p.sex, COUNT(*) FROM persons p WHERE p.sex IN (0,1){af}
            GROUP BY p.sex
        """).fetchall()
        all_dict = {str(int(g)): c for g, c in rows_all}
        denom = sum(all_dict.values())
        if denom == 0:
            continue
        entry = out.setdefault("All", {}).setdefault(_source_label(source), {})
        for k in ("0", "1"):
            v = all_dict.get(k, 0)
            entry[k] = (v / denom) if denom > 0 else 0.0
    return out


class GenderProvider(DataProvider):
    """Gender distribution per polygon and source."""

    ROUTE = "gender.json"
    PARAMS = [
        CANTON, SOURCE, AGE_MIN, AGE_MAX,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        if not _has_age_filter(params):
            return build_share_response(
                sources=sources,
                polygon_ids=polygon_ids,
                column_to_bin=COL_TO_BIN,
                bin_order=["0", "1"],
            )
        return _raw_path(sources, polygon_ids, params)

"""Age-distribution provider.

Backed by ``hot_polygon_demo`` for the fast path; falls back to a raw scan
of ``persons`` when the request cannot be answered from the pre-aggregated
grid (custom ``bounds``, gender filter, …).
"""

from __future__ import annotations

from .base import DataProvider, Param, CANTON, SOURCE, GENDER
from .connection import get_source_cursor
from .constants import DEFAULT_AGE_BINS
from .helpers import (
    age_filter_sql,
    gender_filter_sql,
    get_hot_polygon_meta,
    parse_source_param,
    polygon_ids_from_params,
)
from ._pre_agg import (
    build_share_response,
    label_for,
    make_label_resolver,
    polygon_filter_clause,
    resolve_polygon_ids,
    _source_label,
    _sum_grid,
)


# demo_grid column → bin-label mapping. Order matches DEFAULT_AGE_BINS.
DEFAULT_COL_TO_BIN: dict[str, str] = {
    "age_6_15":  "[6, 15)",
    "age_15_18": "[15, 18)",
    "age_18_24": "[18, 24)",
    "age_24_30": "[24, 30)",
    "age_30_45": "[30, 45)",
    "age_45_65": "[45, 65)",
    "age_65_80": "[65, 80)",
}


def _parse_age_bins(params: dict) -> list[tuple[int, int, str]]:
    bounds_str = params.get("bounds")
    if not bounds_str:
        return DEFAULT_AGE_BINS
    try:
        vals = [int(x.strip()) for x in bounds_str.split(",")]
        if len(vals) < 2:
            return DEFAULT_AGE_BINS
        return [(vals[i], vals[i + 1], f"[{vals[i]}, {vals[i + 1]})")
                for i in range(len(vals) - 1)]
    except Exception:
        return DEFAULT_AGE_BINS


def _is_default_bins(bins: list[tuple[int, int, str]]) -> bool:
    return [b[2] for b in bins] == [b[2] for b in DEFAULT_AGE_BINS]


def _has_attr_filter(params: dict) -> bool:
    return bool(params.get("gender") or params.get("sex"))


# ─── Slow path: raw scan of persons table ────────────────────────────────

def _age_case_sql(bins: list[tuple[int, int, str]], col: str = "age") -> str:
    cases = " ".join(
        f"WHEN {col} >= {lo} AND {col} < {hi} THEN '{label}'"
        for lo, hi, label in bins
    )
    return f"CASE {cases} END"


def _raw_path(sources: list[str], polygon_ids: list[str], params: dict, bins) -> dict:
    bin_order = [b[2] for b in bins]
    age_case = _age_case_sql(bins)
    gf = gender_filter_sql(params)

    out: dict[str, dict[str, dict[str, float]]] = {}

    for source in sources:
        try:
            con = get_source_cursor(source)
        except Exception:
            continue
        # Per-polygon counts via spatial join (uses canton_id shortcut for
        # canton-typed polygons, custom polygon CTE otherwise)
        if polygon_ids:
            pjoin, pwhere, group_expr, pbind, _ = polygon_filter_clause(polygon_ids)
            resolve = make_label_resolver(con, polygon_ids,
                                           all(p.startswith("canton:") for p in polygon_ids))
            sql = f"""
                SELECT {group_expr} AS poly_key, {age_case} AS bin, COUNT(*) AS cnt
                FROM persons p
                {pjoin}
                WHERE p.age IS NOT NULL{pwhere}{gf}
                GROUP BY poly_key, bin
                HAVING bin IS NOT NULL
            """
            rows = con.execute(sql, pbind).fetchall()
            per_pid: dict[str, dict[str, int]] = {}
            for poly_key, bin_label, cnt in rows:
                label = resolve(poly_key)
                per_pid.setdefault(label, {})[bin_label] = cnt
            for label, bins_dict in per_pid.items():
                denom = sum(bins_dict.values())
                if denom == 0:
                    continue
                entry = out.setdefault(label, {}).setdefault(_source_label(source), {})
                for b in bin_order:
                    v = bins_dict.get(b, 0)
                    entry[b] = (v / denom) if denom > 0 else 0.0
        # "All" rollup: scan whole persons table, no spatial filter
        sql_all = f"""
            SELECT {age_case} AS bin, COUNT(*) AS cnt
            FROM persons p
            WHERE p.age IS NOT NULL{gf}
            GROUP BY bin
            HAVING bin IS NOT NULL
        """
        rows_all = con.execute(sql_all).fetchall()
        all_dict = {b: c for b, c in rows_all}
        denom = sum(all_dict.values())
        if denom == 0:
            continue
        entry = out.setdefault("All", {}).setdefault(_source_label(source), {})
        for b in bin_order:
            v = all_dict.get(b, 0)
            entry[b] = (v / denom) if denom > 0 else 0.0

    return out


# ─── Provider ─────────────────────────────────────────────────────────────

class AgeProvider(DataProvider):
    """Age distribution per polygon and source."""

    ROUTE = "age.json"
    PARAMS = [
        CANTON, SOURCE, GENDER,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated (e.g. canton:1,bezirk:101)"),
        Param("bounds", "Custom age bin boundaries (comma-separated)"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        bins = _parse_age_bins(params)

        # Need an arbitrary connection to resolve "all cantons"
        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        # Fast path: default bins, no gender filter → use hot_polygon_demo
        if _is_default_bins(bins) and not _has_attr_filter(params):
            return build_share_response(
                sources=sources,
                polygon_ids=polygon_ids,
                column_to_bin=DEFAULT_COL_TO_BIN,
                bin_order=[b[2] for b in DEFAULT_AGE_BINS],
            )

        return _raw_path(sources, polygon_ids, params, bins)

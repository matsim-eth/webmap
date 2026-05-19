"""PT-subscription rates per polygon, with optional breakdown.

Fast path (overall) → ``hot_polygon_demo``. Breakdowns (age/gender/income)
fall back to a raw scan against ``persons`` (and ``households`` for income).
"""

from __future__ import annotations

from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX
from .constants import SUBS, SUB_LABELS, DEFAULT_AGE_BINS
from .connection import get_source_cursor
from .helpers import (
    age_filter_sql,
    gender_filter_sql,
    get_hot_polygon_meta,
    parse_source_param,
)
from ._pre_agg import (
    label_for,
    resolve_polygon_ids,
    _select_hot_row,
    _sum_grid,
    _source_label,
)


SUB_COL = {s: f"subs_{s}" for s in SUBS}                    # for hot_polygon_demo
PARQUET_SUB_COL = {s: f"subscriptions_{s}" for s in SUBS}   # raw persons scan


def _parse_age_bins(params: dict):
    bs = params.get("bounds")
    if not bs:
        return DEFAULT_AGE_BINS
    try:
        v = [int(x.strip()) for x in bs.split(",")]
        return [(v[i], v[i + 1], f"[{v[i]}, {v[i + 1]})") for i in range(len(v) - 1)] or DEFAULT_AGE_BINS
    except Exception:
        return DEFAULT_AGE_BINS


def _age_case(bins, col="p.age"):
    cases = " ".join(f"WHEN {col} >= {lo} AND {col} < {hi} THEN '{lbl}'" for lo, hi, lbl in bins)
    return f"CASE {cases} END"


def _sub_sum_sql(prefix="p"):
    return ", ".join(
        f"SUM(CASE WHEN {prefix}.{PARQUET_SUB_COL[s]} THEN 1 ELSE 0 END) AS {s}_count"
        for s in SUBS
    )


class PtSubProvider(DataProvider):
    ROUTE = "pt_sub.json"
    PARAMS = [
        CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("breakdown", "Breakdown dimension", default="overall",
              enum=["overall", "age", "gender", "income"]),
        Param("bounds", "Custom age bin boundaries (comma-separated)"),
        Param("subscription", "Filter by subscription type"),
        Param("income_class", "Filter by income class (comma-separated)"),
    ]

    def deliver(self, params: dict) -> dict:
        breakdown = (params.get("breakdown") or "overall").lower()
        if breakdown not in ("overall", "age", "gender", "income"):
            breakdown = "overall"
        sources = parse_source_param(params)
        if not sources:
            return {}
        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        if breakdown == "overall" and not (
            params.get("gender") or params.get("age_min") or params.get("age_max")
            or params.get("income_class")
        ):
            return self._overall_fast(sources, polygon_ids)
        if breakdown == "overall":
            return self._overall_raw(sources, polygon_ids, params)
        if breakdown == "age":
            return self._by_age(sources, polygon_ids, params)
        if breakdown == "gender":
            return self._by_gender(sources, polygon_ids, params)
        return self._by_income(sources, polygon_ids, params)

    # ─── Overall ────────────────────────────────────────────────────────

    def _overall_fast(self, sources, polygon_ids):
        cols = ["n_persons"] + [SUB_COL[s] for s in SUBS]
        out = {}
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            rows = _select_hot_row(con, "hot_polygon_demo", polygon_ids, cols)
            meta = get_hot_polygon_meta(con, list(rows.keys()))
            for pid, vals in rows.items():
                denom = float(vals.get("n_persons", 0) or 0)
                label = label_for(pid, meta)
                entry = out.setdefault(label, {}).setdefault(_source_label(source), {})
                for s in SUBS:
                    num = float(vals.get(SUB_COL[s], 0) or 0)
                    entry[SUB_LABELS[s]] = round(num / denom, 16) if denom > 0 else 0.0

            sums = _sum_grid(con, "demo_hex_res6", cols)
            denom = float(sums.get("n_persons", 0) or 0)
            if denom == 0:
                continue
            entry = out.setdefault("All", {}).setdefault(_source_label(source), {})
            for s in SUBS:
                num = float(sums.get(SUB_COL[s], 0) or 0)
                entry[SUB_LABELS[s]] = round(num / denom, 16) if denom > 0 else 0.0
        return out

    def _overall_raw(self, sources, polygon_ids, params):
        gf = gender_filter_sql(params, "p.sex")
        af = age_filter_sql(params, "p.age")
        out = {}
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            if polygon_ids:
                placeholders = ",".join(["?"] * len(polygon_ids))
                rows = con.execute(f"""
                    SELECT hp.polygon_id, COUNT(*) AS total, {_sub_sum_sql('p')}
                    FROM persons p
                    JOIN hot_polygons hp ON hp.polygon_id IN ({placeholders})
                       AND ST_Within(p.home_pt, hp.polygon_geom)
                    WHERE 1=1{gf}{af}
                    GROUP BY hp.polygon_id
                """, polygon_ids).fetchall()
                meta = get_hot_polygon_meta(con, polygon_ids)
                for r in rows:
                    pid = r[0]; total = float(r[1] or 0)
                    label = label_for(pid, meta)
                    entry = out.setdefault(label, {}).setdefault(_source_label(source), {})
                    for i, s in enumerate(SUBS):
                        num = float(r[2 + i] or 0)
                        entry[SUB_LABELS[s]] = round(num / total, 6) if total > 0 else 0.0

            r = con.execute(f"""
                SELECT COUNT(*) AS total, {_sub_sum_sql('p')}
                FROM persons p WHERE 1=1{gf}{af}
            """).fetchone()
            total = float(r[0] or 0)
            entry = out.setdefault("All", {}).setdefault(_source_label(source), {})
            for i, s in enumerate(SUBS):
                num = float(r[1 + i] or 0)
                entry[SUB_LABELS[s]] = round(num / total, 6) if total > 0 else 0.0
        return out

    # ─── By age ─────────────────────────────────────────────────────────

    def _by_age(self, sources, polygon_ids, params):
        bins = _parse_age_bins(params)
        bin_labels = [b[2] for b in bins]
        gf = gender_filter_sql(params, "p.sex")
        return self._cross_tab(
            sources, polygon_ids,
            grp_sql=_age_case(bins),
            grp_filter=" AND p.age IS NOT NULL",
            extra_where=gf,
            bin_order=bin_labels,
            grp_label_fn=lambda x: x,
        )

    # ─── By gender ──────────────────────────────────────────────────────

    def _by_gender(self, sources, polygon_ids, params):
        af = age_filter_sql(params, "p.age")
        result = self._cross_tab(
            sources, polygon_ids,
            grp_sql="p.sex",
            grp_filter=" AND p.sex IN (0, 1)",
            extra_where=af,
            bin_order=["0", "1"],
            grp_label_fn=lambda x: str(int(x)),
        )
        # Optional subscription filter
        sub_filter = params.get("subscription")
        if sub_filter:
            allowed = {v.strip().lower() for v in sub_filter.split(",")}
            for label_dict in result.values():
                for src_dict in label_dict.values():
                    for grp_dict in src_dict.values():
                        for k in list(grp_dict.keys()):
                            if k.lower() not in allowed:
                                del grp_dict[k]
        return result

    # ─── By income (synthetic only — needs households) ──────────────────

    def _by_income(self, sources, polygon_ids, params):
        # Microcensus has income_class on persons directly
        return self._cross_tab(
            sources, polygon_ids,
            grp_sql="CAST(h.income_class AS INTEGER)",
            grp_filter=" AND h.income_class IS NOT NULL",
            extra_where="",
            bin_order=None,
            grp_label_fn=lambda x: str(int(x)),
            join_clause="JOIN households h ON p.household_id = h.household_id",
        )

    def _cross_tab(self, sources, polygon_ids, *, grp_sql, grp_filter, extra_where,
                   bin_order, grp_label_fn, join_clause=""):
        out = {}
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            counts = defaultdict(int)
            totals = defaultdict(int)
            sub_counts = defaultdict(int)
            overall_totals = defaultdict(int)

            if polygon_ids:
                placeholders = ",".join(["?"] * len(polygon_ids))
                rows = con.execute(f"""
                    SELECT hp.polygon_id, {grp_sql} AS grp, COUNT(*) AS total, {_sub_sum_sql('p')}
                    FROM persons p
                    {join_clause}
                    JOIN hot_polygons hp ON hp.polygon_id IN ({placeholders})
                       AND ST_Within(p.home_pt, hp.polygon_geom)
                    WHERE 1=1{grp_filter}{extra_where}
                    GROUP BY hp.polygon_id, grp
                """, polygon_ids).fetchall()
                meta = get_hot_polygon_meta(con, polygon_ids)
                seen_grps = set()
                for r in rows:
                    pid = r[0]
                    grp = grp_label_fn(r[1]) if r[1] is not None else None
                    if grp is None:
                        continue
                    seen_grps.add(grp)
                    label = label_for(pid, meta)
                    totals[(label, grp)] += int(r[2] or 0)
                    overall_totals[label] += int(r[2] or 0)
                    for i, s in enumerate(SUBS):
                        sub_counts[(label, grp, s)] += int(r[3 + i] or 0)
                grps = bin_order or sorted(seen_grps)
                for label in {k[0] for k in totals.keys()}:
                    src_entry = out.setdefault(label, {}).setdefault(_source_label(source), {})
                    for grp in grps:
                        denom = float(totals.get((label, grp), 0))
                        for s in SUBS:
                            num = float(sub_counts.get((label, grp, s), 0))
                            src_entry.setdefault(grp, {})[SUB_LABELS[s]] = round(num / denom, 6) if denom > 0 else 0.0
                    overall_denom = float(overall_totals.get(label, 0))
                    overall_subs = defaultdict(float)
                    for (lbl, grp, s), c in sub_counts.items():
                        if lbl == label:
                            overall_subs[s] += c
                    for s in SUBS:
                        src_entry.setdefault("All", {})[SUB_LABELS[s]] = round(overall_subs[s] / overall_denom, 6) if overall_denom > 0 else 0.0

            # "All" rollup
            rows_all = con.execute(f"""
                SELECT {grp_sql} AS grp, COUNT(*) AS total, {_sub_sum_sql('p')}
                FROM persons p
                {join_clause}
                WHERE 1=1{grp_filter}{extra_where}
                GROUP BY grp
            """).fetchall()
            grand_subs = defaultdict(int)
            grand_total = 0
            seen_grps = set()
            tot_grp = defaultdict(int)
            sub_grp = defaultdict(int)
            for r in rows_all:
                grp = grp_label_fn(r[1]) if r[1] is not None else (grp_label_fn(r[0]) if r[0] is not None else None)
                # First column is grp (since we don't have hp.polygon_id here)
                grp = grp_label_fn(r[0]) if r[0] is not None else None
                if grp is None:
                    continue
                seen_grps.add(grp)
                tot_grp[grp] += int(r[1] or 0)
                grand_total += int(r[1] or 0)
                for i, s in enumerate(SUBS):
                    sub_grp[(grp, s)] += int(r[2 + i] or 0)
                    grand_subs[s] += int(r[2 + i] or 0)
            grps = bin_order or sorted(seen_grps)
            entry = out.setdefault("All", {}).setdefault(_source_label(source), {})
            for grp in grps:
                denom = float(tot_grp.get(grp, 0))
                for s in SUBS:
                    num = float(sub_grp.get((grp, s), 0))
                    entry.setdefault(grp, {})[SUB_LABELS[s]] = round(num / denom, 6) if denom > 0 else 0.0
            for s in SUBS:
                entry.setdefault("All", {})[SUB_LABELS[s]] = round(grand_subs[s] / grand_total, 6) if grand_total > 0 else 0.0
        return out

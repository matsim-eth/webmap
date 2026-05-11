"""Number-of-cars distribution per polygon.

Three breakdowns:
  ?breakdown=age     → cars × age-bin     (raw scan)
  ?breakdown=gender  → cars × sex          (raw scan)
  ?breakdown=income  → cars × income-class (raw scan, joins households)

Overall aggregates without breakdown could use ``hot_polygon_demo.cars_*``
directly, but the legacy API always returns a breakdown — we keep that.
"""

from __future__ import annotations

from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX
from .constants import DEFAULT_AGE_BINS
from .connection import get_source_cursor
from .helpers import (
    age_filter_sql,
    gender_filter_sql,
    get_hot_polygon_meta,
    parse_source_param,
)
from ._pre_agg import label_for, make_label_resolver, polygon_filter_clause, resolve_polygon_ids, _source_label


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
    cs = " ".join(f"WHEN {col} >= {lo} AND {col} < {hi} THEN '{lbl}'" for lo, hi, lbl in bins)
    return f"CASE {cs} END"


def _cars_class_to_int(val) -> str | None:
    """Map household.n_cars_class VARCHAR ('0','1','2','3+') to int label."""
    if val is None:
        return None
    s = str(val).strip()
    if s in ("0", "1", "2"):
        return s
    if s.startswith("3"):
        return "3"
    try:
        return str(int(float(s)))
    except Exception:
        return None


class NumCarsProvider(DataProvider):
    ROUTE = "num_cars.json"
    PARAMS = [
        CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("breakdown", "Breakdown dimension", default="age", enum=["age", "gender", "income"]),
        Param("bounds", "Custom age bin boundaries"),
        Param("car_class", "Filter by car count class"),
        Param("income_class", "Filter by income class (comma-separated)"),
    ]

    def deliver(self, params: dict) -> dict:
        breakdown = (params.get("breakdown") or "age").lower()
        if breakdown not in ("age", "gender", "income"):
            breakdown = "age"
        sources = parse_source_param(params)
        if not sources:
            return {}
        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")
        if breakdown == "age":
            return self._cross(sources, polygon_ids, params,
                                grp_sql=_age_case(_parse_age_bins(params)),
                                grp_filter=" AND p.age IS NOT NULL",
                                extra_where=gender_filter_sql(params, "p.sex"),
                                bin_order=[b[2] for b in _parse_age_bins(params)],
                                grp_label_fn=lambda x: x)
        if breakdown == "gender":
            res = self._cross(sources, polygon_ids, params,
                               grp_sql="p.sex",
                               grp_filter=" AND p.sex IN (0,1)",
                               extra_where=age_filter_sql(params, "p.age"),
                               bin_order=["0", "1"],
                               grp_label_fn=lambda x: str(int(x)))
            cc_filter = params.get("car_class")
            if cc_filter:
                allowed = {c.strip() for c in cc_filter.split(",")}
                for ld in res.values():
                    for sd in ld.values():
                        for gd in sd.values():
                            for k in list(gd.keys()):
                                if k not in allowed:
                                    del gd[k]
            return res
        # income
        ic_filter = ""
        if params.get("income_class"):
            vals = ", ".join(params["income_class"].split(","))
            ic_filter = f" AND CAST(h.income_class AS INTEGER) IN ({vals})"
        return self._cross(sources, polygon_ids, params,
                            grp_sql="CAST(h.income_class AS INTEGER)",
                            grp_filter=" AND h.income_class IS NOT NULL",
                            extra_where=ic_filter,
                            bin_order=None,
                            grp_label_fn=lambda x: str(int(x)),
                            join="JOIN households h ON p.household_id = h.household_id")

    def _cross(self, sources, polygon_ids, params, *, grp_sql, grp_filter,
               extra_where, bin_order, grp_label_fn, join=""):
        out = {}
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            # We always need households join to read n_cars_class
            full_join = join or "JOIN households h ON p.household_id = h.household_id"
            counts = defaultdict(int)
            totals = defaultdict(int)
            overall_counts = defaultdict(int)
            overall_totals = defaultdict(int)
            seen_grps = set()
            seen_cc = set()

            if polygon_ids:
                pjoin, pwhere, group_expr, pbind, _ = polygon_filter_clause(polygon_ids)
                resolve = make_label_resolver(con, polygon_ids,
                                               all(p.startswith("canton:") for p in polygon_ids))
                rows = con.execute(f"""
                    SELECT {group_expr} AS poly_key, {grp_sql} AS grp, h.n_cars_class
                    FROM persons p
                    {full_join}
                    {pjoin}
                    WHERE h.n_cars_class IS NOT NULL{pwhere}{grp_filter}{extra_where}
                """, pbind).fetchall()
                for poly_key, grp_raw, cc_raw in rows:
                    grp = grp_label_fn(grp_raw) if grp_raw is not None else None
                    cc = _cars_class_to_int(cc_raw)
                    if grp is None or cc is None:
                        continue
                    label = resolve(poly_key)
                    seen_grps.add(grp); seen_cc.add(cc)
                    counts[(label, grp, cc)] += 1
                    totals[(label, grp)] += 1
                    overall_counts[(label, cc)] += 1
                    overall_totals[label] += 1

            rows_all = con.execute(f"""
                SELECT {grp_sql} AS grp, h.n_cars_class
                FROM persons p
                {full_join}
                WHERE h.n_cars_class IS NOT NULL{grp_filter}{extra_where}
            """).fetchall()
            all_counts = defaultdict(int)
            all_totals = defaultdict(int)
            all_oc = defaultdict(int)
            all_ot = 0
            for grp_raw, cc_raw in rows_all:
                grp = grp_label_fn(grp_raw) if grp_raw is not None else None
                cc = _cars_class_to_int(cc_raw)
                if grp is None or cc is None:
                    continue
                seen_grps.add(grp); seen_cc.add(cc)
                all_counts[(grp, cc)] += 1
                all_totals[grp] += 1
                all_oc[cc] += 1
                all_ot += 1

            grps = bin_order or sorted(seen_grps, key=lambda x: (int(x) if x.isdigit() else x))
            cc_classes = sorted(seen_cc, key=lambda x: int(x))

            labels_with_data = {k[0] for k in totals.keys()}
            for label in labels_with_data:
                src = out.setdefault(label, {}).setdefault(_source_label(source), {})
                for grp in grps:
                    denom = float(totals.get((label, grp), 0))
                    for cc in cc_classes:
                        num = float(counts.get((label, grp, cc), 0))
                        src.setdefault(grp, {})[cc] = round(num / denom, 6) if denom > 0 else 0.0
                ov_denom = float(overall_totals.get(label, 0))
                for cc in cc_classes:
                    num = float(overall_counts.get((label, cc), 0))
                    src.setdefault("All", {})[cc] = round(num / ov_denom, 6) if ov_denom > 0 else 0.0

            entry = out.setdefault("All", {}).setdefault(_source_label(source), {})
            for grp in grps:
                denom = float(all_totals.get(grp, 0))
                for cc in cc_classes:
                    num = float(all_counts.get((grp, cc), 0))
                    entry.setdefault(grp, {})[cc] = round(num / denom, 6) if denom > 0 else 0.0
            for cc in cc_classes:
                num = float(all_oc.get(cc, 0))
                entry.setdefault("All", {})[cc] = round(num / all_ot, 6) if all_ot > 0 else 0.0
        return out

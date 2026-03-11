"""PT subscription rates by overall, age, gender, or income.

Consolidates the former 4 endpoints into 1:
  pt_subscriptions.json -> ?breakdown=overall
  pt_sub_age.json       -> ?breakdown=age
  pt_sub_gender.json    -> ?breakdown=gender
  pt_sub_income.json    -> ?breakdown=income

Query params
------------
breakdown    (str): "overall" (default), "age", "gender", or "income".
canton       (str): Comma-separated canton names.
source       (str): "Synthetic", "Microcensus", or omit for both.
gender       (str): "0" or "1" to filter by sex (for breakdown=overall/age).
bounds       (str): Comma-separated age bin boundaries (for breakdown=age).
age_min      (int): Minimum age (inclusive, for breakdown=gender).
age_max      (int): Maximum age (exclusive, for breakdown=gender).
subscription (str): Comma-separated subscription types to include (for breakdown=gender).
income_class (str): Comma-separated income classes to include (for breakdown=income).
"""

import duckdb

from .base import DataProvider
from .constants import SUBS, SUB_LABELS, DEFAULT_AGE_BINS
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    age_filter_sql,
    parse_source_param,
    build_canton_lookup,
)
from .paths import get_data_paths


def _parse_age_bins(params: dict) -> list[tuple[int, int, str]]:
    bounds_str = params.get("bounds")
    if not bounds_str:
        return DEFAULT_AGE_BINS
    try:
        vals = [int(x.strip()) for x in bounds_str.split(",")]
        if len(vals) < 2:
            return DEFAULT_AGE_BINS
        return [(vals[i], vals[i + 1], f"[{vals[i]}, {vals[i + 1]})") for i in range(len(vals) - 1)]
    except Exception:
        return DEFAULT_AGE_BINS


def _age_bin(age, bins: list[tuple[int, int, str]]) -> str | None:
    try:
        a = int(age)
    except Exception:
        return None
    for lo, hi, label in bins:
        if lo <= a < hi:
            return label
    return None


class PtSubProvider(DataProvider):
    ROUTE = "pt_sub.json"

    def deliver(self, params: dict) -> dict:
        breakdown = params.get("breakdown", "overall").lower()
        if breakdown not in ("overall", "age", "gender", "income"):
            breakdown = "overall"

        if breakdown == "overall":
            return self._overall(params)
        elif breakdown == "age":
            return self._by_age(params)
        elif breakdown == "gender":
            return self._by_gender(params)
        else:
            return self._by_income(params)

    def _overall(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        gf = gender_filter_sql(params)
        cols = ", ".join(f"subscriptions_{s}" for s in SUBS)
        con = duckdb.connect()

        def read_rows(path: str, label: str) -> list[tuple]:
            res = con.execute(
                f"SELECT canton_id, {cols} FROM read_parquet(?) WHERE canton_id IS NOT NULL{cf}{gf}",
                [path],
            ).fetchall()
            return [(label, int(row[0]), row[1:]) for row in res]

        rows: list[tuple] = []
        if "Synthetic" in sources:
            rows.extend(read_rows(paths.synthetic_persons, "Synthetic"))
        if "Microcensus" in sources:
            rows.extend(read_rows(paths.microcensus_persons, "Microcensus"))

        counts: dict = {s: {} for s in SUBS}
        totals: dict = {}
        seen_cantons: set = set()

        for source, cid, sub_vals in rows:
            seen_cantons.add(cid)
            totals[(source, cid)]    = totals.get((source, cid), 0) + 1
            totals[(source, "All")] = totals.get((source, "All"), 0) + 1
            for i, s in enumerate(SUBS):
                if sub_vals[i]:
                    counts[s][(source, cid)]    = counts[s].get((source, cid), 0) + 1
                    counts[s][(source, "All")] = counts[s].get((source, "All"), 0) + 1

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                denom = float(totals.get((source, cid), 0))
                for s in SUBS:
                    num = float(counts[s].get((source, cid), 0))
                    share = round(num / denom, 16) if denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {})[SUB_LABELS[s]] = share

        return out

    def _by_age(self, params: dict) -> dict:
        paths = get_data_paths()
        bins = _parse_age_bins(params)
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        gf = gender_filter_sql(params)
        cols = ", ".join(f"subscriptions_{s}" for s in SUBS)
        con = duckdb.connect()

        def read_rows(path: str, label: str) -> list[tuple]:
            res = con.execute(
                f"SELECT canton_id, age, {cols} FROM read_parquet(?) WHERE canton_id IS NOT NULL AND age IS NOT NULL{cf}{gf}",
                [path],
            ).fetchall()
            rows = []
            for row in res:
                cid, age = row[0], row[1]
                sub_vals = row[2:]
                bin_label = _age_bin(age, bins)
                if bin_label is None:
                    continue
                rows.append((label, int(cid), bin_label, sub_vals))
            return rows

        rows: list[tuple] = []
        if "Synthetic" in sources:
            rows.extend(read_rows(paths.synthetic_persons, "Synthetic"))
        if "Microcensus" in sources:
            rows.extend(read_rows(paths.microcensus_persons, "Microcensus"))

        counts: dict = {s: {} for s in SUBS}
        totals: dict = {}
        seen_cantons: set = set()

        for source, cid, bin_label, sub_vals in rows:
            seen_cantons.add(cid)
            totals[(source, cid, bin_label)]    = totals.get((source, cid, bin_label), 0) + 1
            totals[(source, "All", bin_label)] = totals.get((source, "All", bin_label), 0) + 1
            for i, s in enumerate(SUBS):
                if sub_vals[i]:
                    counts[s][(source, cid, bin_label)]    = counts[s].get((source, cid, bin_label), 0) + 1
                    counts[s][(source, "All", bin_label)] = counts[s].get((source, "All", bin_label), 0) + 1

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        bin_labels = [b[2] for b in bins]

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for bin_label in bin_labels:
                    denom = float(totals.get((source, cid, bin_label), 0))
                    for s in SUBS:
                        num = float(counts[s].get((source, cid, bin_label), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(bin_label, {})[SUB_LABELS[s]] = share

        return out

    def _by_gender(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        af = age_filter_sql(params, "age")
        subscription_param = params.get("subscription")
        cols = ", ".join(f"subscriptions_{s}" for s in SUBS)
        con = duckdb.connect()

        def read_rows(path: str, label: str) -> list[tuple]:
            res = con.execute(
                f"SELECT canton_id, sex, {cols} FROM read_parquet(?) WHERE canton_id IS NOT NULL AND sex IS NOT NULL{cf}{af}",
                [path],
            ).fetchall()
            rows = []
            for row in res:
                cid, sex = row[0], row[1]
                sub_vals = row[2:]
                try:
                    g = str(int(sex))
                except Exception:
                    continue
                rows.append((label, int(cid), g, sub_vals))
            return rows

        rows: list[tuple] = []
        if "Synthetic" in sources:
            rows.extend(read_rows(paths.synthetic_persons, "Synthetic"))
        if "Microcensus" in sources:
            rows.extend(read_rows(paths.microcensus_persons, "Microcensus"))

        counts: dict = {s: {} for s in SUBS}
        totals: dict = {}
        seen_cantons: set = set()
        seen_genders: set = set()

        for source, cid, g, sub_vals in rows:
            seen_cantons.add(cid)
            seen_genders.add(g)
            totals[(source, cid, g)]    = totals.get((source, cid, g), 0) + 1
            totals[(source, "All", g)] = totals.get((source, "All", g), 0) + 1
            for i, s in enumerate(SUBS):
                if sub_vals[i]:
                    counts[s][(source, cid, g)]    = counts[s].get((source, cid, g), 0) + 1
                    counts[s][(source, "All", g)] = counts[s].get((source, "All", g), 0) + 1

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        genders = sorted(seen_genders)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for g in genders:
                    denom = float(totals.get((source, cid, g), 0))
                    allowed_subs = None
                    if subscription_param:
                        allowed_subs = {v.strip().lower() for v in subscription_param.split(",")}
                    for s in SUBS:
                        label = SUB_LABELS[s]
                        if allowed_subs and label.lower() not in allowed_subs:
                            continue
                        num = float(counts[s].get((source, cid, g), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(g, {})[label] = share

        return out

    def _by_income(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf_p = canton_filter_sql(params.get("canton"), "p.canton_id")
        sub_cols_p = ", ".join(f"p.subscriptions_{s}" for s in SUBS)
        sub_cols   = ", ".join(f"subscriptions_{s}" for s in SUBS)
        con = duckdb.connect()

        counts: dict = {s: {} for s in SUBS}
        totals: dict = {}
        seen_cantons: set = set()
        seen_incomes: set = set()

        def tally(source: str, cid: int, income, sub_vals) -> None:
            ic = str(int(income))
            seen_cantons.add(cid)
            seen_incomes.add(ic)
            totals[(source, cid, ic)]    = totals.get((source, cid, ic), 0) + 1
            totals[(source, "All", ic)] = totals.get((source, "All", ic), 0) + 1
            for i, s in enumerate(SUBS):
                if sub_vals[i]:
                    counts[s][(source, cid, ic)]    = counts[s].get((source, cid, ic), 0) + 1
                    counts[s][(source, "All", ic)] = counts[s].get((source, "All", ic), 0) + 1

        if "Synthetic" in sources:
            ic_filter = ""
            if params.get("income_class"):
                vals = ", ".join(params["income_class"].split(","))
                ic_filter = f" AND CAST(h.income AS INTEGER) IN ({vals})"
            rows = con.execute(f"""
                SELECT p.canton_id, h.income, {sub_cols_p}
                FROM read_parquet(?) p
                INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
                WHERE p.canton_id IS NOT NULL AND h.income IS NOT NULL AND h.income != -1
                {cf_p}{ic_filter}
            """, [paths.synthetic_persons, paths.synthetic_households]).fetchall()
            for row in rows:
                tally("Synthetic", int(row[0]), row[1], row[2:])

        if "Microcensus" in sources:
            cf_mc = canton_filter_sql(params.get("canton"))
            ic_mc = ""
            if params.get("income_class"):
                vals = ", ".join(params["income_class"].split(","))
                ic_mc = f" AND income_class IN ({vals})"
            rows = con.execute(f"""
                SELECT canton_id, income_class, {sub_cols}
                FROM read_parquet(?)
                WHERE canton_id IS NOT NULL AND income_class IS NOT NULL AND income_class != -1
                {cf_mc}{ic_mc}
            """, [paths.microcensus_persons]).fetchall()
            for row in rows:
                tally("Microcensus", int(row[0]), row[1], row[2:])

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        income_classes = sorted(seen_incomes, key=lambda x: int(x))

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for ic in income_classes:
                    denom = float(totals.get((source, cid, ic), 0))
                    for s in SUBS:
                        num = float(counts[s].get((source, cid, ic), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(ic, {})[SUB_LABELS[s]] = share

        return out

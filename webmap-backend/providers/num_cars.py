"""Number-of-cars distribution by age, gender, or income.

Consolidates the former 3 endpoints into 1:
  num_cars_age.json    -> ?breakdown=age
  num_cars_gender.json -> ?breakdown=gender
  num_cars_income.json -> ?breakdown=income

Query params
------------
breakdown    (str): "age" (default), "gender", or "income".
canton       (str): Comma-separated canton names.
source       (str): "Synthetic", "Microcensus", or omit for both.
bounds       (str): Comma-separated age bin boundaries (only for breakdown=age).
gender       (str): "0" or "1" to filter by sex (for breakdown=age).
age_min      (int): Minimum age (inclusive, for breakdown=gender).
age_max      (int): Maximum age (exclusive, for breakdown=gender).
car_class    (str): Comma-separated car classes to include (for breakdown=gender).
income_class (str): Comma-separated income classes to include (for breakdown=income).
"""

import duckdb

from .base import DataProvider, Param, CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX
from .constants import DEFAULT_AGE_BINS
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


class NumCarsProvider(DataProvider):
    ROUTE = "num_cars.json"
    PARAMS = [
        CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX,
        Param("breakdown", "Breakdown dimension", default="age", enum=["age", "gender", "income"]),
        Param("bounds", "Custom age bin boundaries (comma-separated)"),
        Param("car_class", "Filter by car count class"),
        Param("income_class", "Filter by income class (comma-separated)"),
    ]

    def deliver(self, params: dict) -> dict:
        breakdown = params.get("breakdown", "age").lower()
        if breakdown not in ("age", "gender", "income"):
            breakdown = "age"

        if breakdown == "age":
            return self._by_age(params)
        elif breakdown == "gender":
            return self._by_gender(params)
        else:
            return self._by_income(params)

    def _by_age(self, params: dict) -> dict:
        paths = get_data_paths()
        bins = _parse_age_bins(params)
        sources = parse_source_param(params)
        cf_p = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf_p = gender_filter_sql(params, "p.sex")
        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
        overall_counts: dict = {}
        overall_totals: dict = {}
        seen_cantons: set = set()

        def tally(source: str, cid: int, age, val) -> None:
            bin_label = _age_bin(age, bins)
            if bin_label is None:
                return
            seen_cantons.add(cid)
            cc = str(int(val))
            counts[(source, cid, bin_label, cc)]    = counts.get((source, cid, bin_label, cc), 0) + 1
            totals[(source, cid, bin_label)]         = totals.get((source, cid, bin_label), 0) + 1
            counts[(source, "All", bin_label, cc)]   = counts.get((source, "All", bin_label, cc), 0) + 1
            totals[(source, "All", bin_label)]       = totals.get((source, "All", bin_label), 0) + 1
            overall_counts[(source, cid, cc)] = overall_counts.get((source, cid, cc), 0) + 1
            overall_totals[(source, cid)] = overall_totals.get((source, cid), 0) + 1
            overall_counts[(source, "All", cc)] = overall_counts.get((source, "All", cc), 0) + 1
            overall_totals[(source, "All")] = overall_totals.get((source, "All"), 0) + 1

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, p.age, h.number_of_cars_class
                FROM read_parquet(?) p
                INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
                WHERE p.canton_id IS NOT NULL AND p.age IS NOT NULL AND h.number_of_cars_class IS NOT NULL
                {cf_p}{gf_p}
            """, [paths.synthetic_persons, paths.synthetic_households]).fetchall()
            for cid, age, val in rows:
                tally("Synthetic", int(cid), age, val)

        if "Microcensus" in sources:
            cf_mc = canton_filter_sql(params.get("canton"))
            gf_mc = gender_filter_sql(params)
            rows = con.execute(f"""
                SELECT canton_id, age, number_of_cars_class
                FROM read_parquet(?)
                WHERE canton_id IS NOT NULL AND age IS NOT NULL AND number_of_cars_class IS NOT NULL
                {cf_mc}{gf_mc}
            """, [paths.microcensus_persons]).fetchall()
            for cid, age, val in rows:
                tally("Microcensus", int(cid), age, val)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        car_classes = sorted({k for (_, _, _, k) in counts.keys()}, key=lambda x: int(x))
        bin_labels = [b[2] for b in bins]

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for bin_label in bin_labels:
                    denom = float(totals.get((source, cid, bin_label), 0))
                    for cc in car_classes:
                        num = float(counts.get((source, cid, bin_label, cc), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(bin_label, {})[cc] = share
                overall_denom = float(overall_totals.get((source, cid), 0))
                for cc in car_classes:
                    num = float(overall_counts.get((source, cid, cc), 0))
                    share = round(num / overall_denom, 6) if overall_denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {}).setdefault("All", {})[cc] = share

        return out

    def _by_gender(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf_p = canton_filter_sql(params.get("canton"), "p.canton_id")
        af_p = age_filter_sql(params, "p.age")
        car_class_param = params.get("car_class")
        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
        overall_counts: dict = {}
        overall_totals: dict = {}
        seen_cantons: set = set()

        def tally(source: str, cid: int, sex, val) -> None:
            try:
                g = str(int(sex))
                cc = str(int(val))
            except Exception:
                return
            seen_cantons.add(cid)
            counts[(source, cid, g, cc)] = counts.get((source, cid, g, cc), 0) + 1
            totals[(source, cid, g)]     = totals.get((source, cid, g), 0) + 1
            counts[(source, "All", g, cc)] = counts.get((source, "All", g, cc), 0) + 1
            totals[(source, "All", g)]     = totals.get((source, "All", g), 0) + 1
            overall_counts[(source, cid, cc)] = overall_counts.get((source, cid, cc), 0) + 1
            overall_totals[(source, cid)] = overall_totals.get((source, cid), 0) + 1
            overall_counts[(source, "All", cc)] = overall_counts.get((source, "All", cc), 0) + 1
            overall_totals[(source, "All")] = overall_totals.get((source, "All"), 0) + 1

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, p.sex, h.number_of_cars_class
                FROM read_parquet(?) p
                INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
                WHERE p.canton_id IS NOT NULL AND p.sex IS NOT NULL AND h.number_of_cars_class IS NOT NULL
                {cf_p}{af_p}
            """, [paths.synthetic_persons, paths.synthetic_households]).fetchall()
            for cid, sex, val in rows:
                tally("Synthetic", int(cid), sex, val)

        if "Microcensus" in sources:
            cf_mc = canton_filter_sql(params.get("canton"))
            af_mc = age_filter_sql(params, "age")
            rows = con.execute(f"""
                SELECT canton_id, sex, number_of_cars_class
                FROM read_parquet(?)
                WHERE canton_id IS NOT NULL AND sex IS NOT NULL AND number_of_cars_class IS NOT NULL
                {cf_mc}{af_mc}
            """, [paths.microcensus_persons]).fetchall()
            for cid, sex, val in rows:
                tally("Microcensus", int(cid), sex, val)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        car_classes = sorted({k for (_, _, _, k) in counts.keys()}, key=lambda x: int(x))
        if car_class_param:
            allowed = {c.strip() for c in car_class_param.split(",")}
            car_classes = [c for c in car_classes if c in allowed]
        genders = sorted({k for (_, _, k, _) in counts.keys()})

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for g in genders:
                    denom = float(totals.get((source, cid, g), 0))
                    for cc in car_classes:
                        num = float(counts.get((source, cid, g, cc), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(g, {})[cc] = share
                overall_denom = float(overall_totals.get((source, cid), 0))
                for cc in car_classes:
                    num = float(overall_counts.get((source, cid, cc), 0))
                    share = round(num / overall_denom, 6) if overall_denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {}).setdefault("All", {})[cc] = share

        return out

    def _by_income(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf_p = canton_filter_sql(params.get("canton"), "p.canton_id")
        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
        overall_counts: dict = {}
        overall_totals: dict = {}
        seen_cantons: set = set()

        def tally(source: str, cid: int, income, cars) -> None:
            try:
                ic = str(int(income))
                cc = str(int(cars))
            except Exception:
                return
            seen_cantons.add(cid)
            counts[(source, cid, ic, cc)]   = counts.get((source, cid, ic, cc), 0) + 1
            totals[(source, cid, ic)]        = totals.get((source, cid, ic), 0) + 1
            counts[(source, "All", ic, cc)]  = counts.get((source, "All", ic, cc), 0) + 1
            totals[(source, "All", ic)]      = totals.get((source, "All", ic), 0) + 1
            overall_counts[(source, cid, cc)] = overall_counts.get((source, cid, cc), 0) + 1
            overall_totals[(source, cid)] = overall_totals.get((source, cid), 0) + 1
            overall_counts[(source, "All", cc)] = overall_counts.get((source, "All", cc), 0) + 1
            overall_totals[(source, "All")] = overall_totals.get((source, "All"), 0) + 1

        if "Synthetic" in sources:
            ic_filter = ""
            if params.get("income_class"):
                vals = ", ".join(params["income_class"].split(","))
                ic_filter = f" AND CAST(h.income AS INTEGER) IN ({vals})"
            rows = con.execute(f"""
                SELECT p.canton_id, h.number_of_cars_class, h.income
                FROM read_parquet(?) p
                INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
                WHERE p.canton_id IS NOT NULL
                  AND h.number_of_cars_class IS NOT NULL
                  AND h.income IS NOT NULL AND h.income != -1
                {cf_p}{ic_filter}
            """, [paths.synthetic_persons, paths.synthetic_households]).fetchall()
            for cid, cars, income in rows:
                tally("Synthetic", int(cid), income, cars)

        if "Microcensus" in sources:
            cf_mc = canton_filter_sql(params.get("canton"), "p.canton_id")
            ic_mc = ""
            if params.get("income_class"):
                vals = ", ".join(params["income_class"].split(","))
                ic_mc = f" AND h.income_class IN ({vals})"
            rows = con.execute(f"""
                SELECT p.canton_id, p.number_of_cars_class, h.income_class
                FROM read_parquet(?) p
                INNER JOIN read_parquet(?) h ON h.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND p.number_of_cars_class IS NOT NULL
                  AND h.income_class IS NOT NULL AND h.income_class != -1
                {cf_mc}{ic_mc}
            """, [paths.microcensus_persons, paths.microcensus_households]).fetchall()
            for cid, cars, income in rows:
                tally("Microcensus", int(cid), income, cars)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        car_classes = sorted({k for (_, _, _, k) in counts.keys()}, key=lambda x: int(x))
        income_classes = sorted({k for (_, _, k, _) in counts.keys()}, key=lambda x: int(x))

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for ic in income_classes:
                    denom = float(totals.get((source, cid, ic), 0))
                    for cc in car_classes:
                        num = float(counts.get((source, cid, ic, cc), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(ic, {})[cc] = share
                overall_denom = float(overall_totals.get((source, cid), 0))
                for cc in car_classes:
                    num = float(overall_counts.get((source, cid, cc), 0))
                    share = round(num / overall_denom, 6) if overall_denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {}).setdefault("All", {})[cc] = share

        return out

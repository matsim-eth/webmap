"""PT subscription rates by overall, age, gender, or income."""

from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX
from .constants import SUBS, SUB_LABELS, DEFAULT_AGE_BINS
from .connection import get_connection
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


def _age_bin_sql(bins: list[tuple[int, int, str]], col: str = "age") -> str:
    cases = " ".join(
        f"WHEN {col} >= {lo} AND {col} < {hi} THEN '{label}'"
        for lo, hi, label in bins
    )
    return f"CASE {cases} END"


# SQL fragment to sum subscription columns
def _sub_sums_sql(prefix: str = "") -> str:
    p = f"{prefix}." if prefix else ""
    return ", ".join(
        f"SUM(CASE WHEN {p}subscriptions_{s} THEN 1 ELSE 0 END) AS {s}_count"
        for s in SUBS
    )


class PtSubProvider(DataProvider):
    ROUTE = "pt_sub.json"
    PARAMS = [
        CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX,
        Param("breakdown", "Breakdown dimension", default="overall", enum=["overall", "age", "gender", "income"]),
        Param("bounds", "Custom age bin boundaries (comma-separated)"),
        Param("subscription", "Filter by subscription type"),
        Param("income_class", "Filter by income class (comma-separated)"),
    ]

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
        income_class_param = params.get("income_class")
        con = get_connection()

        # sub_counts[(source, cid, sub_name)] = count
        sub_counts = defaultdict(int)
        totals = defaultdict(int)
        seen_cantons = set()

        if "Synthetic" in sources:
            if income_class_param:
                cf = canton_filter_sql(params.get("canton"), "p.canton_id")
                gf = gender_filter_sql(params, "p.sex")
                af = age_filter_sql(params, "p.age")
                vals = ", ".join(income_class_param.split(","))
                ic_filter = f" AND CAST(h.income AS INTEGER) IN ({vals})"
                rows = con.execute(f"""
                    SELECT p.canton_id, COUNT(*) AS total, {_sub_sums_sql("p")}
                    FROM read_parquet(?) p
                    INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
                    WHERE p.canton_id IS NOT NULL AND h.income IS NOT NULL AND h.income != -1
                    {cf}{gf}{af}{ic_filter}
                    GROUP BY p.canton_id
                """, [paths.synthetic_persons, paths.synthetic_households]).fetchall()
            else:
                cf = canton_filter_sql(params.get("canton"))
                gf = gender_filter_sql(params)
                af = age_filter_sql(params, "age")
                rows = con.execute(f"""
                    SELECT canton_id, COUNT(*) AS total, {_sub_sums_sql()}
                    FROM read_parquet(?)
                    WHERE canton_id IS NOT NULL{cf}{gf}{af}
                    GROUP BY canton_id
                """, [paths.synthetic_persons]).fetchall()
            for row in rows:
                cid = int(row[0])
                total = int(row[1])
                seen_cantons.add(cid)
                totals[("Synthetic", cid)] += total
                for i, s in enumerate(SUBS):
                    sub_counts[("Synthetic", cid, s)] += int(row[2 + i])

        if "Microcensus" in sources:
            cf = canton_filter_sql(params.get("canton"))
            gf = gender_filter_sql(params)
            af = age_filter_sql(params, "age")
            ic_filter = ""
            if income_class_param:
                vals = ", ".join(income_class_param.split(","))
                ic_filter = f" AND income_class IN ({vals}) AND income_class != -1"
            rows = con.execute(f"""
                SELECT canton_id, COUNT(*) AS total, {_sub_sums_sql()}
                FROM read_parquet(?)
                WHERE canton_id IS NOT NULL{cf}{gf}{af}{ic_filter}
                GROUP BY canton_id
            """, [paths.microcensus_persons]).fetchall()
            for row in rows:
                cid = int(row[0])
                total = int(row[1])
                seen_cantons.add(cid)
                totals[("Microcensus", cid)] += total
                for i, s in enumerate(SUBS):
                    sub_counts[("Microcensus", cid, s)] += int(row[2 + i])

        # "All" canton aggregate
        for (source, cid, s), cnt in list(sub_counts.items()):
            sub_counts[(source, "All", s)] += cnt
        for (source, cid), total in list(totals.items()):
            totals[(source, "All")] += total

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                denom = float(totals.get((source, cid), 0))
                for s in SUBS:
                    num = float(sub_counts.get((source, cid, s), 0))
                    share = round(num / denom, 16) if denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {})[SUB_LABELS[s]] = share

        return out

    def _by_breakdown(self, params: dict, breakdown_col_sql: str,
                      breakdown_key_fn, extra_join: str = "",
                      extra_where: str = "", extra_params: list = None) -> dict:
        """Generic breakdown by a grouping column (age bin, gender, income)."""
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        con = get_connection()

        sub_counts = defaultdict(int)
        totals = defaultdict(int)
        overall_sub_counts = defaultdict(int)
        overall_totals = defaultdict(int)
        seen_cantons = set()
        seen_groups = set()

        for source_label, path in [("Synthetic", paths.synthetic_persons),
                                    ("Microcensus", paths.microcensus_persons)]:
            if source_label not in sources:
                continue

            join_clause = extra_join if source_label == "Synthetic" else ""
            where_extra = extra_where if source_label == "Synthetic" else ""
            bind_params = (extra_params or []) if source_label == "Synthetic" else []

            # For microcensus, the table alias is the main table, no join needed
            if source_label == "Microcensus" and extra_join:
                # Microcensus doesn't need household join for income — it has income_class directly
                join_clause = ""
                where_extra = ""
                bind_params = []

            rows = con.execute(f"""
                SELECT canton_id, {breakdown_col_sql} AS grp,
                       COUNT(*) AS total, {_sub_sums_sql()}
                FROM read_parquet(?) {join_clause}
                WHERE canton_id IS NOT NULL{cf}{where_extra}
                  AND {breakdown_col_sql} IS NOT NULL
                GROUP BY canton_id, grp
            """, [path] + bind_params).fetchall()

            for row in rows:
                cid = int(row[0])
                grp_key = breakdown_key_fn(row[1])
                if grp_key is None:
                    continue
                total = int(row[2])
                seen_cantons.add(cid)
                seen_groups.add(grp_key)
                totals[(source_label, cid, grp_key)] += total
                overall_totals[(source_label, cid)] += total
                for i, s in enumerate(SUBS):
                    sub_counts[(source_label, cid, grp_key, s)] += int(row[3 + i])
                    overall_sub_counts[(source_label, cid, s)] += int(row[3 + i])

        # "All" canton aggregates
        for (source, cid, grp, s), cnt in list(sub_counts.items()):
            sub_counts[(source, "All", grp, s)] += cnt
        for (source, cid, grp), total in list(totals.items()):
            totals[(source, "All", grp)] += total
        for (source, cid, s), cnt in list(overall_sub_counts.items()):
            overall_sub_counts[(source, "All", s)] += cnt
        for (source, cid), total in list(overall_totals.items()):
            overall_totals[(source, "All")] += total

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        groups = sorted(seen_groups)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for grp in groups:
                    denom = float(totals.get((source, cid, grp), 0))
                    for s in SUBS:
                        num = float(sub_counts.get((source, cid, grp, s), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(grp, {})[SUB_LABELS[s]] = share
                # "All" aggregate
                overall_denom = float(overall_totals.get((source, cid), 0))
                for s in SUBS:
                    num = float(overall_sub_counts.get((source, cid, s), 0))
                    share = round(num / overall_denom, 6) if overall_denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {}).setdefault("All", {})[SUB_LABELS[s]] = share

        return out

    def _by_age(self, params: dict) -> dict:
        paths = get_data_paths()
        bins = _parse_age_bins(params)
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        gf = gender_filter_sql(params)
        age_case = _age_bin_sql(bins)
        con = get_connection()

        sub_counts = defaultdict(int)
        totals = defaultdict(int)
        overall_sub_counts = defaultdict(int)
        overall_totals = defaultdict(int)
        seen_cantons = set()

        for source_label, path in [("Synthetic", paths.synthetic_persons),
                                    ("Microcensus", paths.microcensus_persons)]:
            if source_label not in sources:
                continue
            rows = con.execute(f"""
                SELECT canton_id, {age_case} AS age_bin,
                       COUNT(*) AS total, {_sub_sums_sql()}
                FROM read_parquet(?)
                WHERE canton_id IS NOT NULL AND age IS NOT NULL{cf}{gf}
                GROUP BY canton_id, age_bin
                HAVING age_bin IS NOT NULL
            """, [path]).fetchall()
            for row in rows:
                cid = int(row[0])
                grp = str(row[1])
                total = int(row[2])
                seen_cantons.add(cid)
                totals[(source_label, cid, grp)] += total
                overall_totals[(source_label, cid)] += total
                for i, s in enumerate(SUBS):
                    sub_counts[(source_label, cid, grp, s)] += int(row[3 + i])
                    overall_sub_counts[(source_label, cid, s)] += int(row[3 + i])

        # "All" canton
        for (source, cid, grp, s), cnt in list(sub_counts.items()):
            sub_counts[(source, "All", grp, s)] += cnt
        for (source, cid, grp), total in list(totals.items()):
            totals[(source, "All", grp)] += total
        for (source, cid, s), cnt in list(overall_sub_counts.items()):
            overall_sub_counts[(source, "All", s)] += cnt
        for (source, cid), total in list(overall_totals.items()):
            overall_totals[(source, "All")] += total

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        bin_labels = [b[2] for b in bins]

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for bl in bin_labels:
                    denom = float(totals.get((source, cid, bl), 0))
                    for s in SUBS:
                        num = float(sub_counts.get((source, cid, bl, s), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(bl, {})[SUB_LABELS[s]] = share
                overall_denom = float(overall_totals.get((source, cid), 0))
                for s in SUBS:
                    num = float(overall_sub_counts.get((source, cid, s), 0))
                    share = round(num / overall_denom, 6) if overall_denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {}).setdefault("All", {})[SUB_LABELS[s]] = share

        return out

    def _by_gender(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        af = age_filter_sql(params, "age")
        con = get_connection()

        sub_counts = defaultdict(int)
        totals = defaultdict(int)
        overall_sub_counts = defaultdict(int)
        overall_totals = defaultdict(int)
        seen_cantons = set()
        seen_genders = set()

        for source_label, path in [("Synthetic", paths.synthetic_persons),
                                    ("Microcensus", paths.microcensus_persons)]:
            if source_label not in sources:
                continue
            rows = con.execute(f"""
                SELECT canton_id, CAST(sex AS INTEGER) AS gender,
                       COUNT(*) AS total, {_sub_sums_sql()}
                FROM read_parquet(?)
                WHERE canton_id IS NOT NULL AND sex IS NOT NULL{cf}{af}
                GROUP BY canton_id, gender
            """, [path]).fetchall()
            for row in rows:
                cid = int(row[0])
                g = str(int(row[1]))
                total = int(row[2])
                seen_cantons.add(cid)
                seen_genders.add(g)
                totals[(source_label, cid, g)] += total
                overall_totals[(source_label, cid)] += total
                for i, s in enumerate(SUBS):
                    sub_counts[(source_label, cid, g, s)] += int(row[3 + i])
                    overall_sub_counts[(source_label, cid, s)] += int(row[3 + i])

        # "All" canton
        for (source, cid, g, s), cnt in list(sub_counts.items()):
            sub_counts[(source, "All", g, s)] += cnt
        for (source, cid, g), total in list(totals.items()):
            totals[(source, "All", g)] += total
        for (source, cid, s), cnt in list(overall_sub_counts.items()):
            overall_sub_counts[(source, "All", s)] += cnt
        for (source, cid), total in list(overall_totals.items()):
            overall_totals[(source, "All")] += total

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        genders = sorted(seen_genders)

        subscription_param = params.get("subscription")
        allowed_subs = None
        if subscription_param:
            allowed_subs = {v.strip().lower() for v in subscription_param.split(",")}

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for g in genders:
                    denom = float(totals.get((source, cid, g), 0))
                    for s in SUBS:
                        label = SUB_LABELS[s]
                        if allowed_subs and label.lower() not in allowed_subs:
                            continue
                        num = float(sub_counts.get((source, cid, g, s), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(g, {})[label] = share
                overall_denom = float(overall_totals.get((source, cid), 0))
                for s in SUBS:
                    label = SUB_LABELS[s]
                    if allowed_subs and label.lower() not in allowed_subs:
                        continue
                    num = float(overall_sub_counts.get((source, cid, s), 0))
                    share = round(num / overall_denom, 6) if overall_denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {}).setdefault("All", {})[label] = share

        return out

    def _by_income(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf_p = canton_filter_sql(params.get("canton"), "p.canton_id")
        con = get_connection()

        sub_counts = defaultdict(int)
        totals = defaultdict(int)
        overall_sub_counts = defaultdict(int)
        overall_totals = defaultdict(int)
        seen_cantons = set()
        seen_incomes = set()

        if "Synthetic" in sources:
            ic_filter = ""
            if params.get("income_class"):
                vals = ", ".join(params["income_class"].split(","))
                ic_filter = f" AND CAST(h.income AS INTEGER) IN ({vals})"
            rows = con.execute(f"""
                SELECT p.canton_id, CAST(h.income AS INTEGER) AS income_class,
                       COUNT(*) AS total, {_sub_sums_sql("p")}
                FROM read_parquet(?) p
                INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
                WHERE p.canton_id IS NOT NULL AND h.income IS NOT NULL AND h.income != -1
                {cf_p}{ic_filter}
                GROUP BY p.canton_id, income_class
            """, [paths.synthetic_persons, paths.synthetic_households]).fetchall()
            for row in rows:
                cid = int(row[0])
                ic = str(int(row[1]))
                total = int(row[2])
                seen_cantons.add(cid)
                seen_incomes.add(ic)
                totals[("Synthetic", cid, ic)] += total
                overall_totals[("Synthetic", cid)] += total
                for i, s in enumerate(SUBS):
                    sub_counts[("Synthetic", cid, ic, s)] += int(row[3 + i])
                    overall_sub_counts[("Synthetic", cid, s)] += int(row[3 + i])

        if "Microcensus" in sources:
            cf_mc = canton_filter_sql(params.get("canton"))
            ic_mc = ""
            if params.get("income_class"):
                vals = ", ".join(params["income_class"].split(","))
                ic_mc = f" AND income_class IN ({vals})"
            rows = con.execute(f"""
                SELECT canton_id, CAST(income_class AS INTEGER) AS ic,
                       COUNT(*) AS total, {_sub_sums_sql()}
                FROM read_parquet(?)
                WHERE canton_id IS NOT NULL AND income_class IS NOT NULL AND income_class != -1
                {cf_mc}{ic_mc}
                GROUP BY canton_id, ic
            """, [paths.microcensus_persons]).fetchall()
            for row in rows:
                cid = int(row[0])
                ic = str(int(row[1]))
                total = int(row[2])
                seen_cantons.add(cid)
                seen_incomes.add(ic)
                totals[("Microcensus", cid, ic)] += total
                overall_totals[("Microcensus", cid)] += total
                for i, s in enumerate(SUBS):
                    sub_counts[("Microcensus", cid, ic, s)] += int(row[3 + i])
                    overall_sub_counts[("Microcensus", cid, s)] += int(row[3 + i])

        # "All" canton
        for (source, cid, ic, s), cnt in list(sub_counts.items()):
            sub_counts[(source, "All", ic, s)] += cnt
        for (source, cid, ic), total in list(totals.items()):
            totals[(source, "All", ic)] += total
        for (source, cid, s), cnt in list(overall_sub_counts.items()):
            overall_sub_counts[(source, "All", s)] += cnt
        for (source, cid), total in list(overall_totals.items()):
            overall_totals[(source, "All")] += total

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        income_classes = sorted(seen_incomes, key=lambda x: int(x))

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for ic in income_classes:
                    denom = float(totals.get((source, cid, ic), 0))
                    for s in SUBS:
                        num = float(sub_counts.get((source, cid, ic, s), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(ic, {})[SUB_LABELS[s]] = share
                overall_denom = float(overall_totals.get((source, cid), 0))
                for s in SUBS:
                    num = float(overall_sub_counts.get((source, cid, s), 0))
                    share = round(num / overall_denom, 6) if overall_denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {}).setdefault("All", {})[SUB_LABELS[s]] = share

        return out

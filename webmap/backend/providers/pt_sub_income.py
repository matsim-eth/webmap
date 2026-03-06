import duckdb

from .base import DataProvider
from .constants import SUBS, SUB_LABELS
from .helpers import canton_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


class PtSubIncomeProvider(DataProvider):
    """PT subscription rates broken down by income class.

    Query params:
        canton       (str): Comma-separated canton names.
        source       (str): "Synthetic", "Microcensus", or omit for both.
        income_class (str): Comma-separated income classes to include.

    Example: /data/pt_sub_income.json?canton=Zurich&income_class=1,2,3
    """

    ROUTE = "pt_sub_income.json"

    def deliver(self, params: dict) -> dict:
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

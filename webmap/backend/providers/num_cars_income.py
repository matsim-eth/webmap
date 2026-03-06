import duckdb

from .base import DataProvider
from .helpers import canton_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


class NumCarsIncomeProvider(DataProvider):
    """Number-of-cars distribution broken down by income class.

    Query params:
        canton       (str): Comma-separated canton names.
        source       (str): "Synthetic", "Microcensus", or omit for both.
        income_class (str): Comma-separated income classes to include.

    Example: /data/num_cars_income.json?canton=Zurich&income_class=1,2,3
    """

    ROUTE = "num_cars_income.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf_p = canton_filter_sql(params.get("canton"), "p.canton_id")
        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
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

        return out

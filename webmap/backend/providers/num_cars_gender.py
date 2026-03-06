import duckdb

from .base import DataProvider
from .helpers import canton_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


class NumCarsGenderProvider(DataProvider):
    """Number-of-cars distribution broken down by gender.

    Query params:
        canton  (str): Comma-separated canton names.
        source  (str): "Synthetic", "Microcensus", or omit for both.

    Example: /data/num_cars_gender.json?canton=Zurich&source=Synthetic
    """

    ROUTE = "num_cars_gender.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf_p = canton_filter_sql(params.get("canton"), "p.canton_id")
        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
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

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, p.sex, h.number_of_cars_class
                FROM read_parquet(?) p
                INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
                WHERE p.canton_id IS NOT NULL AND p.sex IS NOT NULL AND h.number_of_cars_class IS NOT NULL
                {cf_p}
            """, [paths.synthetic_persons, paths.synthetic_households]).fetchall()
            for cid, sex, val in rows:
                tally("Synthetic", int(cid), sex, val)

        if "Microcensus" in sources:
            cf_mc = canton_filter_sql(params.get("canton"))
            rows = con.execute(f"""
                SELECT canton_id, sex, number_of_cars_class
                FROM read_parquet(?)
                WHERE canton_id IS NOT NULL AND sex IS NOT NULL AND number_of_cars_class IS NOT NULL
                {cf_mc}
            """, [paths.microcensus_persons]).fetchall()
            for cid, sex, val in rows:
                tally("Microcensus", int(cid), sex, val)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        car_classes = sorted({k for (_, _, _, k) in counts.keys()}, key=lambda x: int(x))
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

        return out

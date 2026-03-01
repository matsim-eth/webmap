import os

import duckdb

from jsonprovider.DataProvider import FileProvider

CANTON_MAP = {
    1: "Zurich", 2: "Bern", 3: "Luzern", 4: "Uri", 5: "Schwyz",
    6: "Obwalden", 7: "Nidwalden", 8: "Glarus", 9: "Zug", 10: "Fribourg",
    11: "Solothurn", 12: "Basel-Stadt", 13: "Basel-Landschaft", 14: "Schaffhausen",
    15: "AppenzellAusserrhoden", 16: "AppenzellInnerrhoden", 17: "StGallen",
    18: "Graubunden", 19: "Aargau", 20: "Thurgau", 21: "Ticino", 22: "Vaud",
    23: "Valais", 24: "Neuchatel", 25: "Geneve", 26: "Jura",
}


def _canton_name(canton_id):
    try:
        return CANTON_MAP.get(int(canton_id), str(canton_id))
    except Exception:
        return str(canton_id)


class num_cars_income(FileProvider):
    FILE = "num_cars_income.json"

    def _get_root_dir(self):
        root = os.getenv("WEBMAP_ROOT")
        if not root:
            raise RuntimeError("WEBMAP_ROOT is not set.")
        return root

    def _default_paths(self):
        root = self._get_root_dir()
        return (
            os.path.join(root, "synthetic/persons.parquet"),
            os.path.join(root, "synthetic/households.parquet"),
            os.path.join(root, "microcensus/persons.parquet"),
            os.path.join(root, "microcensus/households.parquet"),
        )

    def deliver(self, flt):
        synthetic_persons, synthetic_households, microcensus_persons, microcensus_households = self._default_paths()

        if isinstance(flt, dict):
            synthetic_persons    = flt.get("synthetic_persons")    or synthetic_persons
            synthetic_households = flt.get("synthetic_households") or synthetic_households
            microcensus_persons  = flt.get("microcensus_persons")  or microcensus_persons
            microcensus_households = flt.get("microcensus_households") or microcensus_households

        con = duckdb.connect()

        # Synthetic: persons → households → normal_income (skip -1)
        synthetic_rows = con.execute("""
            SELECT p.canton_id, h.number_of_cars_class, h.income
            FROM read_parquet(?) p
            INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
            WHERE p.canton_id IS NOT NULL
              AND h.number_of_cars_class IS NOT NULL
              AND h.income IS NOT NULL
              AND h.income != -1
        """, [synthetic_persons, synthetic_households]).fetchall()

        # Microcensus: persons → households → income_class (skip -1)
        microcensus_rows = con.execute("""
            SELECT p.canton_id, p.car_availability, h.income_class
            FROM read_parquet(?) p
            INNER JOIN read_parquet(?) h ON h.person_id = p.person_id
            WHERE p.canton_id IS NOT NULL
              AND p.car_availability IS NOT NULL
              AND h.income_class IS NOT NULL
              AND h.income_class != -1
        """, [microcensus_persons, microcensus_households]).fetchall()

        counts = {}
        totals = {}
        seen_cantons = set()

        def tally(source, canton_id, income, cars):
            try:
                ic = str(int(income))
                cc = str(int(cars))
            except Exception:
                return
            seen_cantons.add(canton_id)
            counts[(source, canton_id, ic, cc)] = counts.get((source, canton_id, ic, cc), 0) + 1
            totals[(source, canton_id, ic)]     = totals.get((source, canton_id, ic), 0) + 1
            counts[(source, "All", ic, cc)]     = counts.get((source, "All", ic, cc), 0) + 1
            totals[(source, "All", ic)]         = totals.get((source, "All", ic), 0) + 1

        for canton_id, cars, income in synthetic_rows:
            tally("Synthetic", int(canton_id), income, cars)

        for canton_id, cars, income in microcensus_rows:
            tally("Microcensus", int(canton_id), income, cars)

        canton_names = [_canton_name(cid) for cid in sorted(seen_cantons)]
        canton_ids_by_name = {_canton_name(cid): cid for cid in sorted(seen_cantons)}
        car_classes = sorted({k for (_, _, _, k) in counts.keys()}, key=lambda x: int(x))
        income_classes = sorted({k for (_, _, k, _) in counts.keys()}, key=lambda x: int(x))

        out = {}
        for canton_name in canton_names + ["All"]:
            cid = canton_ids_by_name.get(canton_name, "All")
            for source in ("Synthetic", "Microcensus"):
                for ic in income_classes:
                    denom = float(totals.get((source, cid, ic), 0))
                    for cc in car_classes:
                        num = float(counts.get((source, cid, ic, cc), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(canton_name, {}).setdefault(source, {}).setdefault(ic, {})[cc] = share

        return out
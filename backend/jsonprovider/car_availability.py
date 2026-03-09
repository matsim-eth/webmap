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


class car_availability(FileProvider):
    FILE = "car_availability.json"

    def _get_root_dir(self):
        root = os.getenv("WEBMAP_ROOT")
        if not root:
            raise RuntimeError("WEBMAP_ROOT is not set.")
        return root

    def _default_paths(self):
        root = self._get_root_dir()
        return (
            os.path.join(root, "synthetic/switzerland_persons.parquet"),
            os.path.join(root, "synthetic/switzerland_households.parquet"),
            os.path.join(root, "microcensus/persons.parquet"),
        )

    def deliver(self, flt):
        synthetic_persons, synthetic_households, microcensus_persons = self._default_paths()

        if isinstance(flt, dict):
            synthetic_persons    = flt.get("synthetic_persons")    or synthetic_persons
            synthetic_households = flt.get("synthetic_households") or synthetic_households
            microcensus_persons  = flt.get("microcensus_persons")  or microcensus_persons

        con = duckdb.connect()

        # Synthetic: join persons → households to get number_of_cars_class
        synthetic_rows = con.execute("""
            SELECT p.canton_id, h.number_of_cars_class
            FROM read_parquet(?) p
            INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
            WHERE p.canton_id IS NOT NULL AND h.number_of_cars_class IS NOT NULL
        """, [synthetic_persons, synthetic_households]).fetchall()

        # Microcensus: car_availability directly on persons
        microcensus_rows = con.execute("""
            SELECT canton_id, car_availability
            FROM read_parquet(?)
            WHERE canton_id IS NOT NULL AND car_availability IS NOT NULL
        """, [microcensus_persons]).fetchall()

        counts = {}
        totals = {}

        seen_cantons = set()

        def tally(source, canton_id, val):
            seen_cantons.add(canton_id)
            key = str(int(val))
            counts[(source, canton_id, key)] = counts.get((source, canton_id, key), 0) + 1
            totals[(source, canton_id)]      = totals.get((source, canton_id), 0) + 1
            counts[(source, "All", key)]     = counts.get((source, "All", key), 0) + 1
            totals[(source, "All")]          = totals.get((source, "All"), 0) + 1

        for canton_id, val in synthetic_rows:
            tally("Synthetic", int(canton_id), val)

        for canton_id, val in microcensus_rows:
            tally("Microcensus", int(canton_id), val)

        canton_names = [_canton_name(cid) for cid in sorted(seen_cantons)]
        canton_ids_by_name = {_canton_name(cid): cid for cid in sorted(seen_cantons)}

        # Collect all car classes seen
        car_classes = sorted({k for (_, _, k) in counts.keys()}, key=lambda x: int(x))

        out = {}
        for canton_name in canton_names + ["All"]:
            cid = canton_ids_by_name.get(canton_name, "All")
            for source in ("Synthetic", "Microcensus"):
                denom = float(totals.get((source, cid), 0))
                for cc in car_classes:
                    num = float(counts.get((source, cid, cc), 0))
                    share = round(num / denom, 16) if denom > 0 else 0.0
                    out.setdefault(canton_name, {}).setdefault(source, {})[cc] = share

        return out
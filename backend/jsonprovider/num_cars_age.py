import os

import duckdb

from jsonprovider.DataProvider import FileProvider

#http://localhost:8000/data/num_cars_age.json?bounds=6,15,18,24,30,45,65,80


CANTON_MAP = {
    1: "Zurich", 2: "Bern", 3: "Luzern", 4: "Uri", 5: "Schwyz",
    6: "Obwalden", 7: "Nidwalden", 8: "Glarus", 9: "Zug", 10: "Fribourg",
    11: "Solothurn", 12: "Basel-Stadt", 13: "Basel-Landschaft", 14: "Schaffhausen",
    15: "AppenzellAusserrhoden", 16: "AppenzellInnerrhoden", 17: "StGallen",
    18: "Graubunden", 19: "Aargau", 20: "Thurgau", 21: "Ticino", 22: "Vaud",
    23: "Valais", 24: "Neuchatel", 25: "Geneve", 26: "Jura",
}

DEFAULT_AGE_BINS = [
    (6,  15,  "[6, 15)"),
    (15, 18,  "[15, 18)"),
    (18, 24,  "[18, 24)"),
    (24, 30,  "[24, 30)"),
    (30, 45,  "[30, 45)"),
    (45, 65,  "[45, 65)"),
    (65, 80,  "[65, 80)"),
]


def _canton_name(canton_id):
    try:
        return CANTON_MAP.get(int(canton_id), str(canton_id))
    except Exception:
        return str(canton_id)


def _parse_bins(flt):
    """
    Optionally parse custom age bins from query params.
    Expects: bounds=6,15,18,24,30,45,65,80
    → produces bins [(6,15,"[6, 15)"), (15,18,"[15, 18)"), ...]
    """
    bounds_str = flt.get("bounds") if flt else None
    if not bounds_str:
        return DEFAULT_AGE_BINS
    try:
        vals = [int(x.strip()) for x in bounds_str.split(",")]
        if len(vals) < 2:
            return DEFAULT_AGE_BINS
        bins = []
        for i in range(len(vals) - 1):
            lo, hi = vals[i], vals[i + 1]
            bins.append((lo, hi, f"[{lo}, {hi})"))
        return bins
    except Exception:
        return DEFAULT_AGE_BINS


def _age_bin(age, bins):
    try:
        a = int(age)
    except Exception:
        return None
    for lo, hi, label in bins:
        if lo <= a < hi:
            return label
    return None


class num_cars_age(FileProvider):
    FILE = "num_cars_age.json"

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
        )

    def deliver(self, flt):
        synthetic_persons, synthetic_households, microcensus_persons = self._default_paths()

        if isinstance(flt, dict):
            synthetic_persons    = flt.get("synthetic_persons")    or synthetic_persons
            synthetic_households = flt.get("synthetic_households") or synthetic_households
            microcensus_persons  = flt.get("microcensus_persons")  or microcensus_persons

        bins = _parse_bins(flt)

        con = duckdb.connect()

        synthetic_rows = con.execute("""
            SELECT p.canton_id, p.age, h.number_of_cars_class
            FROM read_parquet(?) p
            INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
            WHERE p.canton_id IS NOT NULL AND p.age IS NOT NULL AND h.number_of_cars_class IS NOT NULL
        """, [synthetic_persons, synthetic_households]).fetchall()

        microcensus_rows = con.execute("""
            SELECT canton_id, age, car_availability
            FROM read_parquet(?)
            WHERE canton_id IS NOT NULL AND age IS NOT NULL AND car_availability IS NOT NULL
        """, [microcensus_persons]).fetchall()

        counts = {}
        totals = {}
        seen_cantons = set()

        def tally(source, canton_id, age, val):
            bin_label = _age_bin(age, bins)
            if bin_label is None:
                return
            seen_cantons.add(canton_id)
            cc = str(int(val))
            counts[(source, canton_id, bin_label, cc)] = counts.get((source, canton_id, bin_label, cc), 0) + 1
            totals[(source, canton_id, bin_label)]     = totals.get((source, canton_id, bin_label), 0) + 1
            counts[(source, "All", bin_label, cc)]     = counts.get((source, "All", bin_label, cc), 0) + 1
            totals[(source, "All", bin_label)]         = totals.get((source, "All", bin_label), 0) + 1

        for canton_id, age, val in synthetic_rows:
            tally("Synthetic", int(canton_id), age, val)

        for canton_id, age, val in microcensus_rows:
            tally("Microcensus", int(canton_id), age, val)

        canton_names = [_canton_name(cid) for cid in sorted(seen_cantons)]
        canton_ids_by_name = {_canton_name(cid): cid for cid in sorted(seen_cantons)}
        car_classes = sorted({k for (_, _, _, k) in counts.keys()}, key=lambda x: int(x))
        bin_labels = [b[2] for b in bins]

        out = {}
        for canton_name in canton_names + ["All"]:
            cid = canton_ids_by_name.get(canton_name, "All")
            for source in ("Synthetic", "Microcensus"):
                for bin_label in bin_labels:
                    denom = float(totals.get((source, cid, bin_label), 0))
                    for cc in car_classes:
                        num = float(counts.get((source, cid, bin_label, cc), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(canton_name, {}).setdefault(source, {}).setdefault(bin_label, {})[cc] = share

        return out
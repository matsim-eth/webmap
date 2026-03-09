# http://localhost:8000/data/pt_sub_age.json
# http://localhost:8000/data/pt_sub_age.json?bounds=6,18,65,80

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

SUBS = ["ga", "halbtax", "verbund", "strecke", "gleis7", "junior", "other"]
SUB_LABELS = {s: s.capitalize() for s in SUBS}

DEFAULT_AGE_BINS = [
    (6,  15, "[6, 15)"),
    (15, 18, "[15, 18)"),
    (18, 24, "[18, 24)"),
    (24, 30, "[24, 30)"),
    (30, 45, "[30, 45)"),
    (45, 65, "[45, 65)"),
    (65, 80, "[65, 80)"),
]


def _canton_name(canton_id):
    try:
        return CANTON_MAP.get(int(canton_id), str(canton_id))
    except Exception:
        return str(canton_id)


def _parse_bins(flt):
    bounds_str = flt.get("bounds") if flt else None
    if not bounds_str:
        return DEFAULT_AGE_BINS
    try:
        vals = [int(x.strip()) for x in bounds_str.split(",")]
        if len(vals) < 2:
            return DEFAULT_AGE_BINS
        return [(vals[i], vals[i+1], f"[{vals[i]}, {vals[i+1]})") for i in range(len(vals)-1)]
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


class pt_sub_age(FileProvider):
    FILE = "pt_sub_age.json"

    def _get_root_dir(self):
        root = os.getenv("WEBMAP_ROOT")
        if not root:
            raise RuntimeError("WEBMAP_ROOT is not set.")
        return root

    def _default_paths(self):
        root = self._get_root_dir()
        return (
            os.path.join(root, "synthetic/switzerland_persons.parquet"),
            os.path.join(root, "microcensus/persons.parquet"),
        )

    def deliver(self, flt):
        synthetic_persons, microcensus_persons = self._default_paths()

        if isinstance(flt, dict):
            synthetic_persons   = flt.get("synthetic_persons")   or synthetic_persons
            microcensus_persons = flt.get("microcensus_persons") or microcensus_persons

        bins = _parse_bins(flt)
        cols = ", ".join(f"subscriptions_{s}" for s in SUBS)

        con = duckdb.connect()

        def read_rows(path, label):
            res = con.execute(
                f"SELECT canton_id, age, {cols} FROM read_parquet(?) WHERE canton_id IS NOT NULL AND age IS NOT NULL",
                [path],
            ).fetchall()
            rows = []
            for row in res:
                canton_id, age = row[0], row[1]
                sub_vals = row[2:]
                bin_label = _age_bin(age, bins)
                if bin_label is None:
                    continue
                rows.append((label, int(canton_id), bin_label, sub_vals))
            return rows

        rows = []
        rows.extend(read_rows(synthetic_persons, "Synthetic"))
        rows.extend(read_rows(microcensus_persons, "Microcensus"))

        counts = {s: {} for s in SUBS}
        totals = {}
        seen_cantons = set()

        for source, canton_id, bin_label, sub_vals in rows:
            seen_cantons.add(canton_id)
            totals[(source, canton_id, bin_label)] = totals.get((source, canton_id, bin_label), 0) + 1
            totals[(source, "All", bin_label)]     = totals.get((source, "All", bin_label), 0) + 1
            for i, s in enumerate(SUBS):
                if sub_vals[i]:
                    counts[s][(source, canton_id, bin_label)] = counts[s].get((source, canton_id, bin_label), 0) + 1
                    counts[s][(source, "All", bin_label)]     = counts[s].get((source, "All", bin_label), 0) + 1

        canton_names = [_canton_name(cid) for cid in sorted(seen_cantons)]
        canton_ids_by_name = {_canton_name(cid): cid for cid in sorted(seen_cantons)}
        bin_labels = [b[2] for b in bins]

        out = {}
        for canton_name in canton_names + ["All"]:
            cid = canton_ids_by_name.get(canton_name, "All")
            for source in ("Synthetic", "Microcensus"):
                for bin_label in bin_labels:
                    denom = float(totals.get((source, cid, bin_label), 0))
                    for s in SUBS:
                        num = float(counts[s].get((source, cid, bin_label), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(canton_name, {}).setdefault(source, {}).setdefault(bin_label, {})[SUB_LABELS[s]] = share

        return out
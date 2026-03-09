# http://localhost:8000/data/pt_sub_gender.json

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


def _canton_name(canton_id):
    try:
        return CANTON_MAP.get(int(canton_id), str(canton_id))
    except Exception:
        return str(canton_id)


class pt_sub_gender(FileProvider):
    FILE = "pt_sub_gender.json"

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

        cols = ", ".join(f"subscriptions_{s}" for s in SUBS)

        con = duckdb.connect()

        def read_rows(path, label):
            res = con.execute(
                f"SELECT canton_id, sex, {cols} FROM read_parquet(?) WHERE canton_id IS NOT NULL AND sex IS NOT NULL",
                [path],
            ).fetchall()
            rows = []
            for row in res:
                canton_id, sex = row[0], row[1]
                sub_vals = row[2:]
                try:
                    g = str(int(sex))
                except Exception:
                    continue
                rows.append((label, int(canton_id), g, sub_vals))
            return rows

        rows = []
        rows.extend(read_rows(synthetic_persons, "Synthetic"))
        rows.extend(read_rows(microcensus_persons, "Microcensus"))

        counts = {s: {} for s in SUBS}
        totals = {}
        seen_cantons = set()
        seen_genders = set()

        for source, canton_id, g, sub_vals in rows:
            seen_cantons.add(canton_id)
            seen_genders.add(g)
            totals[(source, canton_id, g)] = totals.get((source, canton_id, g), 0) + 1
            totals[(source, "All", g)]     = totals.get((source, "All", g), 0) + 1
            for i, s in enumerate(SUBS):
                if sub_vals[i]:
                    counts[s][(source, canton_id, g)] = counts[s].get((source, canton_id, g), 0) + 1
                    counts[s][(source, "All", g)]     = counts[s].get((source, "All", g), 0) + 1

        canton_names = [_canton_name(cid) for cid in sorted(seen_cantons)]
        canton_ids_by_name = {_canton_name(cid): cid for cid in sorted(seen_cantons)}
        genders = sorted(seen_genders)

        out = {}
        for canton_name in canton_names + ["All"]:
            cid = canton_ids_by_name.get(canton_name, "All")
            for source in ("Synthetic", "Microcensus"):
                for g in genders:
                    denom = float(totals.get((source, cid, g), 0))
                    for s in SUBS:
                        num = float(counts[s].get((source, cid, g), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(canton_name, {}).setdefault(source, {}).setdefault(g, {})[SUB_LABELS[s]] = share

        return out
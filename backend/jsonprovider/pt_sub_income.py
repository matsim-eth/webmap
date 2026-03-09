# http://localhost:8000/data/pt_sub_income.json

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


class pt_sub_income(FileProvider):
    FILE = "pt_sub_income.json"

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
            os.path.join(root, "microcensus/households.parquet"),
        )

    def deliver(self, flt):
        synthetic_persons, synthetic_households, microcensus_persons, microcensus_households = self._default_paths()

        if isinstance(flt, dict):
            synthetic_persons      = flt.get("synthetic_persons")      or synthetic_persons
            synthetic_households   = flt.get("synthetic_households")   or synthetic_households
            microcensus_persons    = flt.get("microcensus_persons")    or microcensus_persons
            microcensus_households = flt.get("microcensus_households") or microcensus_households

        sub_cols = ", ".join(f"p.subscriptions_{s}" for s in SUBS)
        con = duckdb.connect()

        synthetic_rows = con.execute(f"""
            SELECT p.canton_id, h.income, {sub_cols}
            FROM read_parquet(?) p
            INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
            WHERE p.canton_id IS NOT NULL AND h.income IS NOT NULL AND h.income != -1
        """, [synthetic_persons, synthetic_households]).fetchall()

        microcensus_rows = con.execute(f"""
            SELECT canton_id, income_class, {", ".join(f"subscriptions_{s}" for s in SUBS)}
            FROM read_parquet(?)
            WHERE canton_id IS NOT NULL AND income_class IS NOT NULL AND income_class != -1
        """, [microcensus_persons]).fetchall()

        counts = {s: {} for s in SUBS}
        totals = {}
        seen_cantons = set()
        seen_incomes = set()

        def tally(source, canton_id, income, sub_vals):
            ic = str(int(income))
            seen_cantons.add(canton_id)
            seen_incomes.add(ic)
            totals[(source, canton_id, ic)] = totals.get((source, canton_id, ic), 0) + 1
            totals[(source, "All", ic)]     = totals.get((source, "All", ic), 0) + 1
            for i, s in enumerate(SUBS):
                if sub_vals[i]:
                    counts[s][(source, canton_id, ic)] = counts[s].get((source, canton_id, ic), 0) + 1
                    counts[s][(source, "All", ic)]     = counts[s].get((source, "All", ic), 0) + 1

        for row in synthetic_rows:
            tally("Synthetic", int(row[0]), row[1], row[2:])

        for row in microcensus_rows:
            tally("Microcensus", int(row[0]), row[1], row[2:])

        canton_names = [_canton_name(cid) for cid in sorted(seen_cantons)]
        canton_ids_by_name = {_canton_name(cid): cid for cid in sorted(seen_cantons)}
        income_classes = sorted(seen_incomes, key=lambda x: int(x))

        out = {}
        for canton_name in canton_names + ["All"]:
            cid = canton_ids_by_name.get(canton_name, "All")
            for source in ("Synthetic", "Microcensus"):
                for ic in income_classes:
                    denom = float(totals.get((source, cid, ic), 0))
                    for s in SUBS:
                        num = float(counts[s].get((source, cid, ic), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(canton_name, {}).setdefault(source, {}).setdefault(ic, {})[SUB_LABELS[s]] = share

        return out
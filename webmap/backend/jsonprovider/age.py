import os
import json

import duckdb

from webmap.backend.jsonprovider.DataProvider import FileProvider


class age(FileProvider):
    FILE = "age.json"

    def _get_root_dir(self):
        root = os.getenv("WEBMAP_ROOT")
        if not root:
            raise RuntimeError(
                "WEBMAP_ROOT is not set. Set it to the directory that contains persons.parquet (and optional other input files)."
            )
        return root

    def canton_id_to_name(self, canton_id):
        m = {
            1: "Zurich",
            2: "Bern",
            3: "Luzern",
            4: "Uri",
            5: "Schwyz",
            6: "Obwalden",
            7: "Nidwalden",
            8: "Glarus",
            9: "Zug",
            10: "Fribourg",
            11: "Solothurn",
            12: "Basel-Stadt",
            13: "Basel-Landschaft",
            14: "Schaffhausen",
            15: "AppenzellAusserrhoden",
            16: "AppenzellInnerrhoden",
            17: "StGallen",
            18: "Graubunden",
            19: "Aargau",
            20: "Thurgau",
            21: "Ticino",
            22: "Vaud",
            23: "Valais",
            24: "Neuchatel",
            25: "Geneve",
            26: "Jura",
        }
        try:
            return m.get(int(canton_id), str(canton_id))
        except Exception:
            return str(canton_id)

    def _age_bin(self, age):
        if age is None:
            return None
        try:
            a = int(age)
        except Exception:
            return None

        if 6 <= a < 15:
            return "[6, 15)"
        if 15 <= a < 18:
            return "[15, 18)"
        if 18 <= a < 24:
            return "[18, 24)"
        if 24 <= a < 30:
            return "[24, 30)"
        if 30 <= a < 45:
            return "[30, 45)"
        if 45 <= a < 65:
            return "[45, 65)"
        if 65 <= a < 80:
            return "[65, 80)"
        return None

    def _default_paths(self):
        root = self._get_root_dir()
        p = os.path.join(root, "persons.parquet")
        return p, p

    def deliver(self, flt):
        synthetic_path, microcensus_path = self._default_paths()

        if isinstance(flt, dict):
            synthetic_path = flt.get("synthetic_path") or synthetic_path
            microcensus_path = flt.get("microcensus_path") or microcensus_path

        con = duckdb.connect()

        def read_rows(path, label):
            res = con.execute(
                "SELECT age, canton_id FROM read_parquet(?)",
                [path],
            ).fetchall()

            rows = []
            for age, canton_id in res:
                b = self._age_bin(age)
                if b is None:
                    continue
                rows.append((label, int(canton_id), b))
            return rows

        rows = []
        rows.extend(read_rows(synthetic_path, "Synthetic"))
        rows.extend(read_rows(microcensus_path, "Microcensus"))

        out = {}

        def add_share(canton_name, source, bin_label, share):
            out.setdefault(canton_name, {}).setdefault(source, {})[bin_label] = float(share)

        counts = {}
        totals = {}

        for source, canton_id, bin_label in rows:
            key = (source, canton_id, bin_label)
            counts[key] = counts.get(key, 0) + 1
            totals[(source, canton_id)] = totals.get((source, canton_id), 0) + 1
            counts[(source, "All", bin_label)] = counts.get((source, "All", bin_label), 0) + 1
            totals[(source, "All")] = totals.get((source, "All"), 0) + 1

        bins_order = ["[6, 15)", "[15, 18)", "[18, 24)", "[24, 30)", "[30, 45)", "[45, 65)", "[65, 80)"]

        seen_cantons = set()
        for (_, canton_id, _) in rows:
            seen_cantons.add(canton_id)

        canton_names = [self.canton_id_to_name(cid) for cid in sorted(seen_cantons)]
        canton_ids_by_name = {self.canton_id_to_name(cid): cid for cid in sorted(seen_cantons)}

        for canton_name in canton_names + ["All"]:
            for source in ("Synthetic", "Microcensus"):
                for b in bins_order:
                    if canton_name == "All":
                        denom = float(totals.get((source, "All"), 0))
                        num = float(counts.get((source, "All", b), 0))
                    else:
                        cid = canton_ids_by_name.get(canton_name)
                        denom = float(totals.get((source, cid), 0))
                        num = float(counts.get((source, cid, b), 0))

                    share = (num / denom) if denom > 0 else 0.0
                    add_share(canton_name, source, b, share)

        return out
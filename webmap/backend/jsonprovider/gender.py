

import os

import duckdb

from jsonprovider.DataProvider import FileProvider


class gender(FileProvider):
    FILE = "gender.json"

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

    def _default_paths(self):
        root = self._get_root_dir()
        print(root)
        m = os.path.join(root, "microcensus/persons.parquet")
        s = os.path.join(root, "synthetic/persons.parquet")
        return s, m

    def deliver(self, flt):
        synthetic_path, microcensus_path = self._default_paths()

        gender_col = "sex"

        synthetic_path = synthetic_path
        microcensus_path = microcensus_path
        gender_col = gender_col

        con = duckdb.connect()

        def read_rows(path, label):
            res = con.execute(
                f"SELECT {gender_col}, canton_id FROM read_parquet(?)",
                [path],
            ).fetchall()

            rows = []
            for g, canton_id in res:
                if g is None:
                    continue
                try:
                    g = int(g)
                except Exception:
                    continue
                if g not in (0, 1):
                    continue
                rows.append((label, int(canton_id), str(g)))
            return rows

        rows = []
        rows.extend(read_rows(synthetic_path, "Synthetic"))
        rows.extend(read_rows(microcensus_path, "Microcensus"))

        out = {}

        def add_share(canton_name, source, g_label, share):
            out.setdefault(canton_name, {}).setdefault(source, {})[g_label] = float(share)

        counts = {}
        totals = {}

        for source, canton_id, g_label in rows:
            counts[(source, canton_id, g_label)] = counts.get((source, canton_id, g_label), 0) + 1
            totals[(source, canton_id)] = totals.get((source, canton_id), 0) + 1

            counts[(source, "All", g_label)] = counts.get((source, "All", g_label), 0) + 1
            totals[(source, "All")] = totals.get((source, "All"), 0) + 1

        genders_order = ["0", "1"]

        seen_cantons = set()
        for (_, canton_id, _) in rows:
            seen_cantons.add(canton_id)

        canton_names = [self.canton_id_to_name(cid) for cid in sorted(seen_cantons)]
        canton_ids_by_name = {self.canton_id_to_name(cid): cid for cid in sorted(seen_cantons)}

        for canton_name in canton_names + ["All"]:
            for source in ("Synthetic", "Microcensus"):
                for g in genders_order:
                    if canton_name == "All":
                        denom = float(totals.get((source, "All"), 0))
                        num = float(counts.get((source, "All", g), 0))
                    else:
                        cid = canton_ids_by_name.get(canton_name)
                        denom = float(totals.get((source, cid), 0))
                        num = float(counts.get((source, cid, g), 0))

                    share = (num / denom) if denom > 0 else 0.0
                    add_share(canton_name, source, g, share)

        return out
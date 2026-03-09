import os

import duckdb

from jsonprovider.DataProvider import FileProvider
# http://localhost:8000/data/departure_times.json?start_min=360&end_min=1080&step_min=15
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


def _slot_label(minutes, step):
    h = minutes // 60
    m = minutes % 60
    return f"{h}:{m:02d}:00"


class departure_times(FileProvider):
    FILE = "departure_times.json"

    def _get_root_dir(self):
        root = os.getenv("WEBMAP_ROOT")
        if not root:
            raise RuntimeError("WEBMAP_ROOT is not set.")
        return root

    def _default_paths(self):
        root = self._get_root_dir()
        return (
            os.path.join(root, "synthetic/trips.parquet"),
            os.path.join(root, "microcensus/trips.parquet"),
            os.path.join(root, "synthetic/switzerland_persons.parquet"),
            os.path.join(root, "microcensus/persons.parquet"),
        )

    def deliver(self, flt):
        synthetic_trips, microcensus_trips, synthetic_persons, microcensus_persons = self._default_paths()

        if isinstance(flt, dict):
            synthetic_trips      = flt.get("synthetic_trips")      or synthetic_trips
            microcensus_trips    = flt.get("microcensus_trips")    or microcensus_trips
            synthetic_persons    = flt.get("synthetic_persons")    or synthetic_persons
            microcensus_persons  = flt.get("microcensus_persons")  or microcensus_persons

        # Filter params (in minutes); default: full day (0–1440), step 30 min
        start_min = int(flt.get("start_min", 0))   if flt else 0
        end_min   = int(flt.get("end_min",   1440)) if flt else 1440
        step      = int(flt.get("step_min",  30))   if flt else 30

        # Build ordered time slots
        slots = list(range(start_min, end_min, step))

        con = duckdb.connect()

        def read_rows(trips_path, persons_path, label, purpose_col):
            res = con.execute(f"""
                SELECT t.departure_time, t.{purpose_col}, p.canton_id
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
            """, [trips_path, persons_path]).fetchall()
            rows = []
            for dep, purpose, canton_id in res:
                if dep is None or purpose is None or canton_id is None:
                    continue
                try:
                    dep_min = int(dep) // 60  # seconds → minutes
                except Exception:
                    continue
                if dep_min < 0 or dep_min >= 1440:
                    continue
                if dep_min < start_min or dep_min >= end_min:
                    continue
                slot = (dep_min - start_min) // step * step + start_min
                rows.append((label, int(canton_id), str(purpose), slot))
            return rows

        rows = []
        rows.extend(read_rows(synthetic_trips,   synthetic_persons,   "Synthetic",   "preceding_purpose"))
        rows.extend(read_rows(microcensus_trips, microcensus_persons, "Microcensus", "purpose"))

        # Count per (source, canton, purpose, slot) + totals per (source, canton, purpose)
        counts = {}
        totals = {}

        seen_cantons = set()
        seen_purposes = set()

        for source, canton_id, purpose, slot in rows:
            seen_cantons.add(canton_id)
            seen_purposes.add(purpose)
            counts[(source, canton_id, purpose, slot)] = counts.get((source, canton_id, purpose, slot), 0) + 1
            totals[(source, canton_id, purpose)]       = totals.get((source, canton_id, purpose), 0) + 1
            # "All" canton aggregation
            counts[(source, "All", purpose, slot)] = counts.get((source, "All", purpose, slot), 0) + 1
            totals[(source, "All", purpose)]       = totals.get((source, "All", purpose), 0) + 1
            # "All" purpose aggregation
            counts[(source, canton_id, "All", slot)] = counts.get((source, canton_id, "All", slot), 0) + 1
            totals[(source, canton_id, "All")]       = totals.get((source, canton_id, "All"), 0) + 1
            counts[(source, "All", "All", slot)] = counts.get((source, "All", "All", slot), 0) + 1
            totals[(source, "All", "All")]       = totals.get((source, "All", "All"), 0) + 1

        canton_names = [_canton_name(cid) for cid in sorted(seen_cantons)]
        canton_ids_by_name = {_canton_name(cid): cid for cid in sorted(seen_cantons)}
        purposes = sorted(seen_purposes) + ["All"]

        out = {}
        for canton_name in canton_names + ["All"]:
            cid = canton_ids_by_name.get(canton_name, "All")
            for source in ("Synthetic", "Microcensus"):
                for purpose in purposes:
                    denom = float(totals.get((source, cid, purpose), 0))
                    slot_data = {}
                    for s in slots:
                        num = float(counts.get((source, cid, purpose, s), 0))
                        slot_data[_slot_label(s, step)] = round(num / denom, 8) if denom > 0 else 0.0
                    out.setdefault(canton_name, {}).setdefault(source, {})[purpose] = slot_data

        return out
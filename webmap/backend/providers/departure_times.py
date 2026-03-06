import duckdb

from .base import DataProvider
from .constants import canton_name
from .helpers import canton_filter_sql, parse_source_param, build_canton_lookup, mode_filter_sql
from .paths import get_data_paths


def _slot_label(minutes: int) -> str:
    h = minutes // 60
    m = minutes % 60
    return f"{h}:{m:02d}:00"


class DepartureTimesProvider(DataProvider):
    """Departure time distribution per canton, source and trip purpose.

    Query params:
        start_min (int): Start of time window in minutes from midnight. Default: 0.
        end_min   (int): End of time window in minutes from midnight. Default: 1440.
        step_min  (int): Slot width in minutes. Default: 30.
        canton    (str): Comma-separated canton names.
        source    (str): "Synthetic", "Microcensus", or omit for both.
        mode      (str): Comma-separated transport modes to include.

    Example: /data/departure_times.json?start_min=360&end_min=1080&step_min=15&canton=Zurich
    """

    ROUTE = "departure_times.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)

        start_min = int(params.get("start_min", 0))
        end_min   = int(params.get("end_min", 1440))
        step      = int(params.get("step_min", 30))
        slots     = list(range(start_min, end_min, step))

        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        mf = mode_filter_sql(params, "t.mode")

        con = duckdb.connect()

        def read_rows(trips_path: str, persons_path: str, label: str, purpose_col: str) -> list[tuple]:
            res = con.execute(f"""
                SELECT t.departure_time, t.{purpose_col}, p.canton_id
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL{cf}{mf}
            """, [trips_path, persons_path]).fetchall()

            rows = []
            for dep, purpose, cid in res:
                if dep is None or purpose is None or cid is None:
                    continue
                try:
                    dep_min = int(dep) // 60
                except Exception:
                    continue
                if dep_min < start_min or dep_min >= end_min:
                    continue
                slot = (dep_min - start_min) // step * step + start_min
                rows.append((label, int(cid), str(purpose), slot))
            return rows

        rows: list[tuple] = []
        if "Synthetic" in sources:
            rows.extend(read_rows(paths.synthetic_trips, paths.synthetic_persons, "Synthetic", "preceding_purpose"))
        if "Microcensus" in sources:
            rows.extend(read_rows(paths.microcensus_trips, paths.microcensus_persons, "Microcensus", "purpose"))

        counts: dict = {}
        totals: dict = {}
        seen_cantons: set = set()
        seen_purposes: set = set()

        for source, cid, purpose, slot in rows:
            seen_cantons.add(cid)
            seen_purposes.add(purpose)
            counts[(source, cid, purpose, slot)]   = counts.get((source, cid, purpose, slot), 0) + 1
            totals[(source, cid, purpose)]         = totals.get((source, cid, purpose), 0) + 1
            counts[(source, "All", purpose, slot)] = counts.get((source, "All", purpose, slot), 0) + 1
            totals[(source, "All", purpose)]       = totals.get((source, "All", purpose), 0) + 1
            counts[(source, cid, "All", slot)]     = counts.get((source, cid, "All", slot), 0) + 1
            totals[(source, cid, "All")]           = totals.get((source, cid, "All"), 0) + 1
            counts[(source, "All", "All", slot)]   = counts.get((source, "All", "All", slot), 0) + 1
            totals[(source, "All", "All")]         = totals.get((source, "All", "All"), 0) + 1

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        purposes = sorted(seen_purposes) + ["All"]

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for purpose in purposes:
                    denom = float(totals.get((source, cid, purpose), 0))
                    slot_data = {
                        _slot_label(s): round(float(counts.get((source, cid, purpose, s), 0)) / denom, 8)
                        if denom > 0 else 0.0
                        for s in slots
                    }
                    out.setdefault(cname, {}).setdefault(source, {})[purpose] = slot_data

        return out

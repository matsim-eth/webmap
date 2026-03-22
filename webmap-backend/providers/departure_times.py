from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, MODE
from .connection import get_connection
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
    """

    ROUTE = "departure_times.json"
    PARAMS = [
        CANTON, SOURCE, MODE,
        Param("start_min", "Start of time window in minutes from midnight", default=0, param_type="integer"),
        Param("end_min", "End of time window in minutes from midnight", default=1440, param_type="integer"),
        Param("step_min", "Bin width in minutes", default=30, param_type="integer"),
    ]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)

        start_min = int(params.get("start_min", 0))
        end_min   = int(params.get("end_min", 1440))
        step      = int(params.get("step_min", 30))
        slots     = list(range(start_min, end_min, step))

        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        mf = mode_filter_sql(params, "t.mode")

        con = get_connection()

        counts = defaultdict(int)
        seen_cantons = set()
        seen_purposes = set()

        def run_query(trip_path, person_path, source, purpose_col):
            rows = con.execute(f"""
                SELECT p.canton_id, t.{purpose_col} AS purpose,
                       (CAST(t.departure_time AS INTEGER) / 60 - {start_min}) / {step} * {step} + {start_min} AS slot,
                       COUNT(*) AS cnt
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.departure_time IS NOT NULL
                  AND t.{purpose_col} IS NOT NULL
                  AND CAST(t.departure_time AS INTEGER) / 60 >= {start_min}
                  AND CAST(t.departure_time AS INTEGER) / 60 < {end_min}
                  {cf}{mf}
                GROUP BY p.canton_id, purpose, slot
            """, [trip_path, person_path]).fetchall()
            for cid, purpose, slot, cnt in rows:
                seen_cantons.add(int(cid))
                seen_purposes.add(str(purpose))
                counts[(source, int(cid), str(purpose), int(slot))] += cnt

        if "Synthetic" in sources:
            run_query(paths.synthetic_trips, paths.synthetic_persons, "Synthetic", "preceding_purpose")
        if "Microcensus" in sources:
            run_query(paths.microcensus_trips, paths.microcensus_persons, "Microcensus", "purpose")

        # "All" canton aggregate
        all_canton = defaultdict(int)
        for (source, cid, purpose, slot), cnt in counts.items():
            all_canton[(source, "All", purpose, slot)] += cnt
        counts.update(all_canton)

        # "All" purpose aggregate
        all_purpose = defaultdict(int)
        for (source, cid, purpose, slot), cnt in counts.items():
            if purpose != "All":
                all_purpose[(source, cid, "All", slot)] += cnt
        counts.update(all_purpose)

        # Totals per (source, cid, purpose) for denominator
        totals = defaultdict(int)
        for (source, cid, purpose, slot), cnt in counts.items():
            totals[(source, cid, purpose)] += cnt

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

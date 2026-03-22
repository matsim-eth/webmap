from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, PURPOSE
from .connection import get_connection
from .helpers import canton_filter_sql, parse_source_param, build_canton_lookup, purpose_filter_sql
from .paths import get_data_paths


def _slot_label(minutes: int) -> str:
    h = minutes // 60
    m = minutes % 60
    return f"{h}:{m:02d}:00"


class ActivityDurationsProvider(DataProvider):
    """Activity duration distribution per canton, source, and purpose.

    Query params:
        canton    (str): Comma-separated canton names.
        source    (str): "Synthetic", "Microcensus", or omit for both.
        purpose   (str): Comma-separated purposes to include.
        step_min  (int): Slot width in minutes. Default: 30.
        max_hours (int): Maximum duration in hours. Default: 24.
    """

    ROUTE = "activity_durations.json"
    PARAMS = [CANTON, SOURCE, PURPOSE,
              Param("step_min", "Slot width in minutes (default 30)", param_type="integer"),
              Param("max_hours", "Maximum duration in hours (default 24)", param_type="integer")]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)

        step = int(params.get("step_min", 30))
        max_hours = int(params.get("max_hours", 24))
        max_min = max_hours * 60
        max_slot = max_min - step
        slots = list(range(0, max_min, step))

        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        pf = purpose_filter_sql(params, "purpose")

        con = get_connection()

        # counts[(source, cid, purpose, slot)] = count
        counts = defaultdict(int)
        seen_cantons = set()
        seen_purposes = set()

        if "Synthetic" in sources:
            rows = con.execute(f"""
                WITH raw AS (
                    SELECT p.canton_id, a.purpose,
                           CAST(FLOOR(CAST(a.end_time - a.start_time AS DOUBLE) / 60) AS INTEGER) AS dur_min
                    FROM read_parquet(?) a
                    INNER JOIN read_parquet(?) p ON a.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL
                      AND a.end_time IS NOT NULL AND a.start_time IS NOT NULL
                      AND a.end_time >= a.start_time
                      {cf}{pf.replace("purpose", "a.purpose")}
                )
                SELECT canton_id, purpose,
                       LEAST((dur_min / {step}) * {step}, {max_slot}) AS slot,
                       COUNT(*) AS cnt
                FROM raw
                GROUP BY canton_id, purpose, slot
            """, [paths.synthetic_activities, paths.synthetic_persons]).fetchall()
            for cid, purpose, slot, cnt in rows:
                seen_cantons.add(int(cid))
                seen_purposes.add(str(purpose))
                counts[("Synthetic", int(cid), str(purpose), int(slot))] += cnt

        if "Microcensus" in sources:
            rows = con.execute(f"""
                WITH raw AS (
                    SELECT p.canton_id, t.purpose,
                           CAST(FLOOR(CAST(t.activity_duration AS DOUBLE) / 60) AS INTEGER) AS dur_min
                    FROM read_parquet(?) t
                    INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL
                      AND t.activity_duration IS NOT NULL
                      AND t.activity_duration >= 0
                      {cf}{pf.replace("purpose", "t.purpose")}
                )
                SELECT canton_id, purpose,
                       LEAST((dur_min / {step}) * {step}, {max_slot}) AS slot,
                       COUNT(*) AS cnt
                FROM raw
                GROUP BY canton_id, purpose, slot
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, purpose, slot, cnt in rows:
                seen_cantons.add(int(cid))
                seen_purposes.add(str(purpose))
                counts[("Microcensus", int(cid), str(purpose), int(slot))] += cnt

        # Compute "All" canton aggregate
        all_canton = defaultdict(int)
        for (source, cid, purpose, slot), cnt in counts.items():
            all_canton[(source, "All", purpose, slot)] += cnt
        counts.update(all_canton)

        # Compute "All" purpose aggregate
        all_purpose = defaultdict(int)
        for (source, cid, purpose, slot), cnt in counts.items():
            if purpose != "All":
                all_purpose[(source, cid, "All", slot)] += cnt
        counts.update(all_purpose)

        # Compute totals per (source, cid) for denominator
        totals = defaultdict(int)
        for (source, cid, purpose, slot), cnt in counts.items():
            if purpose == "All":
                totals[(source, cid)] += cnt

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        purposes = sorted(seen_purposes) + ["All"]

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for purpose in purposes:
                    denom = float(totals.get((source, cid), 0))
                    slot_data = {
                        _slot_label(s): round(float(counts.get((source, cid, purpose, s), 0)) / denom, 8)
                        if denom > 0 else 0.0
                        for s in slots
                    }
                    out.setdefault(cname, {}).setdefault(source, {})[purpose] = slot_data

        return out

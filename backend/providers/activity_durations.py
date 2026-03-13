import duckdb

from .base import DataProvider, Param, CANTON, SOURCE, PURPOSE
from .helpers import canton_filter_sql, parse_source_param, build_canton_lookup, purpose_filter_sql
from .paths import get_data_paths


PURPOSE_MAP = {"home": "H", "work": "W", "shop": "S", "leisure": "L", "education": "E", "other": "O"}


def _slot_label(minutes: int) -> str:
    """Format a duration in minutes as 'H:MM:SS'."""
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

    Example: /data/activity_durations.json?canton=Zurich&step_min=30&max_hours=24
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
        slots = list(range(0, max_min, step))

        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        pf = purpose_filter_sql(params, "purpose")

        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
        seen_cantons: set = set()
        seen_purposes: set = set()

        def process_row(source: str, cid: int, purpose: str, duration_sec: float) -> None:
            if duration_sec is None or duration_sec < 0:
                return
            dur_min = int(duration_sec) // 60
            if dur_min >= max_min:
                dur_min = max_min - step  # cap into last slot
            slot = (dur_min // step) * step

            seen_cantons.add(cid)
            seen_purposes.add(purpose)

            counts[(source, cid, purpose, slot)] = counts.get((source, cid, purpose, slot), 0) + 1
            totals[(source, cid)] = totals.get((source, cid), 0) + 1
            counts[(source, "All", purpose, slot)] = counts.get((source, "All", purpose, slot), 0) + 1
            totals[(source, "All")] = totals.get((source, "All"), 0) + 1

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT a.purpose, a.end_time - a.start_time AS duration, p.canton_id
                FROM read_parquet(?) a
                INNER JOIN read_parquet(?) p ON a.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND a.end_time IS NOT NULL AND a.start_time IS NOT NULL
                  {cf}{pf.replace("purpose", "a.purpose")}
            """, [paths.synthetic_activities, paths.synthetic_persons]).fetchall()
            for purpose, duration, cid in rows:
                if purpose is None or cid is None:
                    continue
                process_row("Synthetic", int(cid), str(purpose), float(duration))

        if "Microcensus" in sources:
            rows = con.execute(f"""
                SELECT t.purpose, t.activity_duration, p.canton_id
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.activity_duration IS NOT NULL
                  {cf}{pf.replace("purpose", "t.purpose")}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for purpose, duration, cid in rows:
                if purpose is None or cid is None:
                    continue
                process_row("Microcensus", int(cid), str(purpose), float(duration))

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        purposes = sorted(seen_purposes)

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

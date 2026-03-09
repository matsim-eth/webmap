import duckdb

from .base import DataProvider
from .helpers import canton_filter_sql, gender_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


class NumActivitiesProvider(DataProvider):
    """Distribution of number of activities per person, per canton and source.

    Query params:
        canton         (str): Comma-separated canton names.
        source         (str): "Synthetic", "Microcensus", or omit for both.
        gender         (str): "0" or "1" to filter by sex.
        max_activities (int): Cap activity count at this value. Default: 19.

    Example: /data/num_activities.json?canton=Zurich&max_activities=15
    """

    ROUTE = "num_activities.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        max_act = int(params.get("max_activities", 19))

        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = gender_filter_sql(params, "p.sex")

        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
        seen_cantons: set = set()

        def tally(source: str, cid: int, num_act: int) -> None:
            if num_act > max_act:
                num_act = max_act
            key = str(num_act)
            seen_cantons.add(cid)
            counts[(source, cid, key)] = counts.get((source, cid, key), 0) + 1
            totals[(source, cid)] = totals.get((source, cid), 0) + 1
            counts[(source, "All", key)] = counts.get((source, "All", key), 0) + 1
            totals[(source, "All")] = totals.get((source, "All"), 0) + 1

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT a.person_id, COUNT(*) AS num_act, p.canton_id
                FROM read_parquet(?) a
                INNER JOIN read_parquet(?) p ON a.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL{cf}{gf}
                GROUP BY a.person_id, p.canton_id
            """, [paths.synthetic_activities, paths.synthetic_persons]).fetchall()
            for _, num_act, cid in rows:
                tally("Synthetic", int(cid), int(num_act))

        if "Microcensus" in sources:
            # Each trip connects two activities, so num_activities = num_trips + 1
            rows = con.execute(f"""
                SELECT t.person_id, COUNT(*) + 1 AS num_act, p.canton_id
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL{cf}{gf}
                GROUP BY t.person_id, p.canton_id
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for _, num_act, cid in rows:
                tally("Microcensus", int(cid), int(num_act))

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        all_keys = sorted({k for (_, _, k) in counts.keys()}, key=lambda x: int(x))

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                denom = float(totals.get((source, cid), 0))
                for key in all_keys:
                    num = float(counts.get((source, cid, key), 0))
                    share = round(num / denom, 16) if denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {})[key] = share

        return out

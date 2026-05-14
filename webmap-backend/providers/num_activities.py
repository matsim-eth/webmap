from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, GENDER
from .connection import get_connection
from .helpers import canton_filter_sql, gender_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


class NumActivitiesProvider(DataProvider):
    """Distribution of number of activities per person, per canton and source."""

    ROUTE = "num_activities.json"
    PARAMS = [CANTON, SOURCE, GENDER,
              Param("max_activities", "Cap activity count at this value (default 19)", param_type="integer")]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        max_act = int(params.get("max_activities", 19))

        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = gender_filter_sql(params, "p.sex")

        con = get_connection()

        counts = defaultdict(int)
        seen_cantons = set()

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT canton_id, LEAST(num_act, {max_act}) AS capped, COUNT(*) AS cnt
                FROM (
                    SELECT p.canton_id, COUNT(*) AS num_act
                    FROM read_parquet(?) a
                    INNER JOIN read_parquet(?) p ON a.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL{cf}{gf}
                    GROUP BY a.person_id, p.canton_id
                )
                GROUP BY canton_id, capped
            """, [paths.synthetic_activities, paths.synthetic_persons]).fetchall()
            for cid, num, cnt in rows:
                seen_cantons.add(int(cid))
                counts[("Synthetic", int(cid), str(int(num)))] += cnt

        if "Microcensus" in sources:
            rows = con.execute(f"""
                SELECT canton_id, LEAST(num_act, {max_act}) AS capped, COUNT(*) AS cnt
                FROM (
                    SELECT p.canton_id, COUNT(*) + 1 AS num_act
                    FROM read_parquet(?) t
                    INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL{cf}{gf}
                    GROUP BY t.person_id, p.canton_id
                )
                GROUP BY canton_id, capped
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, num, cnt in rows:
                seen_cantons.add(int(cid))
                counts[("Microcensus", int(cid), str(int(num)))] += cnt

        # "All" canton aggregate
        all_canton = defaultdict(int)
        for (source, cid, key), cnt in counts.items():
            all_canton[(source, "All", key)] += cnt
        counts.update(all_canton)

        # Totals per (source, cid)
        totals = defaultdict(int)
        for (source, cid, key), cnt in counts.items():
            totals[(source, cid)] += cnt

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

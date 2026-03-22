from collections import defaultdict

from .base import DataProvider, CANTON, SOURCE, AGE_MIN, AGE_MAX
from .connection import get_connection
from .helpers import canton_filter_sql, age_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


class GenderProvider(DataProvider):
    """Gender distribution per canton and source."""

    ROUTE = "gender.json"
    PARAMS = [CANTON, SOURCE, AGE_MIN, AGE_MAX]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        af = age_filter_sql(params)
        con = get_connection()

        counts = defaultdict(int)
        seen_cantons = set()

        for source_label, path in [("Synthetic", paths.synthetic_persons),
                                    ("Microcensus", paths.microcensus_persons)]:
            if source_label not in sources:
                continue
            rows = con.execute(f"""
                SELECT canton_id, CAST(sex AS INTEGER) AS gender, COUNT(*) AS cnt
                FROM read_parquet(?)
                WHERE canton_id IS NOT NULL AND sex IS NOT NULL
                  AND CAST(sex AS INTEGER) IN (0, 1)
                  {cf}{af}
                GROUP BY canton_id, gender
            """, [path]).fetchall()
            for cid, g, cnt in rows:
                seen_cantons.add(int(cid))
                counts[(source_label, int(cid), str(int(g)))] += cnt

        # "All" canton aggregate
        all_canton = defaultdict(int)
        for (source, cid, g), cnt in counts.items():
            all_canton[(source, "All", g)] += cnt
        counts.update(all_canton)

        # Totals per (source, cid)
        totals = defaultdict(int)
        for (source, cid, g), cnt in counts.items():
            totals[(source, cid)] += cnt

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for g in ["0", "1"]:
                    denom = float(totals.get((source, cid), 0))
                    num = float(counts.get((source, cid, g), 0))
                    share = (num / denom) if denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {})[g] = share

        return out

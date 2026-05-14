from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, GENDER
from .connection import get_connection
from .helpers import canton_filter_sql, gender_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


_PURPOSE_ABBREV = """
    CASE purpose
        WHEN 'work' THEN 'W'
        WHEN 'shop' THEN 'S'
        WHEN 'leisure' THEN 'L'
        WHEN 'education' THEN 'E'
        ELSE 'O'
    END
"""


class OutOfHomeProvider(DataProvider):
    """Out-of-home activity category distribution per canton and source."""

    ROUTE = "out_of_home.json"
    PARAMS = [CANTON, SOURCE, GENDER,
              Param("top_n", "Number of top categories to return (default 10)", param_type="integer")]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        top_n = int(params.get("top_n", 10))

        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = gender_filter_sql(params, "p.sex")

        con = get_connection()

        counts = defaultdict(int)
        totals = defaultdict(int)
        seen_cantons = set()

        def run_query(act_path, person_path, source, purpose_col, id_col, index_col):
            rows = con.execute(f"""
                WITH person_purpose AS (
                    SELECT p.canton_id, a.person_id, a.{purpose_col} AS purpose,
                           COUNT(*) AS cnt
                    FROM read_parquet(?) a
                    INNER JOIN read_parquet(?) p ON a.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL
                      AND a.{purpose_col} IS NOT NULL
                      AND a.{purpose_col} != 'home'
                      {cf}{gf}
                    GROUP BY p.canton_id, a.person_id, a.{purpose_col}
                ),
                categories AS (
                    SELECT canton_id,
                           CAST(cnt AS VARCHAR) || {_PURPOSE_ABBREV} AS category
                    FROM person_purpose
                )
                SELECT canton_id, category, COUNT(*) AS cnt
                FROM categories
                GROUP BY canton_id, category
            """, [act_path, person_path]).fetchall()
            for cid, cat, cnt in rows:
                seen_cantons.add(int(cid))
                counts[(source, int(cid), str(cat))] += cnt
                totals[(source, int(cid))] += cnt

        if "Synthetic" in sources:
            run_query(paths.synthetic_activities, paths.synthetic_persons,
                      "Synthetic", "purpose", "person_id", "activity_index")
        if "Microcensus" in sources:
            run_query(paths.microcensus_trips, paths.microcensus_persons,
                      "Microcensus", "purpose", "person_id", "trip_id")

        # "All" canton aggregate
        all_canton_counts = defaultdict(int)
        all_canton_totals = defaultdict(int)
        for (source, cid, cat), cnt in counts.items():
            all_canton_counts[(source, "All", cat)] += cnt
        counts.update(all_canton_counts)
        for (source, cid), total in totals.items():
            all_canton_totals[(source, "All")] += total
        totals.update(all_canton_totals)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                denom = float(totals.get((source, cid), 0))
                if denom == 0:
                    continue
                cat_shares = {}
                for (s, c, cat), cnt in counts.items():
                    if s == source and c == cid:
                        cat_shares[cat] = round(float(cnt) / denom, 16)
                sorted_cats = sorted(cat_shares.items(), key=lambda x: -x[1])[:top_n]
                out.setdefault(cname, {}).setdefault(source, {})
                for cat, share in sorted_cats:
                    out[cname][source][cat] = share

        return out

import duckdb
from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, GENDER
from .helpers import canton_filter_sql, gender_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


PURPOSE_MAP = {"home": "H", "work": "W", "shop": "S", "leisure": "L", "education": "E", "other": "O"}


class OutOfHomeProvider(DataProvider):
    """Out-of-home activity category distribution per canton and source.

    For each person, non-home activities are counted by purpose type.
    Each (count, purpose_abbrev) pair becomes a category like "1W", "2L".
    Shares are computed across all persons in a canton+source group.

    Query params:
        canton (str): Comma-separated canton names.
        source (str): "Synthetic", "Microcensus", or omit for both.
        top_n  (int): Number of top categories to return. Default: 10.
        gender (str): "0" or "1" to filter by sex.

    Example: /data/out_of_home.json?canton=Zurich&top_n=15
    """

    ROUTE = "out_of_home.json"
    PARAMS = [CANTON, SOURCE, GENDER,
              Param("top_n", "Number of top categories to return (default 10)", param_type="integer")]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        top_n = int(params.get("top_n", 10))

        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = gender_filter_sql(params, "p.sex")

        con = duckdb.connect()

        # counts[(source, cid, category)] = number of person-purpose components
        counts: dict = {}
        totals: dict = {}
        seen_cantons: set = set()

        def process_person_activities(source: str, cid: int,
                                      purpose_counts: dict[str, int]) -> None:
            """Given a person's non-home purpose counts, emit category keys."""
            seen_cantons.add(cid)
            for purpose, cnt in purpose_counts.items():
                abbrev = PURPOSE_MAP.get(purpose, "O")
                cat = f"{cnt}{abbrev}"
                counts[(source, cid, cat)] = counts.get((source, cid, cat), 0) + 1
                totals[(source, cid)] = totals.get((source, cid), 0) + 1
                counts[(source, "All", cat)] = counts.get((source, "All", cat), 0) + 1
                totals[(source, "All")] = totals.get((source, "All"), 0) + 1

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT a.person_id, a.purpose, p.canton_id
                FROM read_parquet(?) a
                INNER JOIN read_parquet(?) p ON a.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND a.purpose IS NOT NULL
                  AND a.purpose != 'home'
                  {cf}{gf}
            """, [paths.synthetic_activities, paths.synthetic_persons]).fetchall()

            # Group by person
            person_data: dict[tuple[int, int], dict[str, int]] = defaultdict(lambda: defaultdict(int))
            for pid, purpose, cid in rows:
                person_data[(int(pid), int(cid))][str(purpose)] += 1
            for (pid, cid), pcounts in person_data.items():
                process_person_activities("Synthetic", cid, pcounts)

        if "Microcensus" in sources:
            rows = con.execute(f"""
                SELECT t.person_id, t.purpose, p.canton_id
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.purpose IS NOT NULL
                  AND t.purpose != 'home'
                  {cf}{gf}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()

            person_data = defaultdict(lambda: defaultdict(int))
            for pid, purpose, cid in rows:
                person_data[(int(pid), int(cid))][str(purpose)] += 1
            for (pid, cid), pcounts in person_data.items():
                process_person_activities("Microcensus", cid, pcounts)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                denom = float(totals.get((source, cid), 0))
                if denom == 0:
                    continue
                # Collect all categories for this canton+source
                cat_shares = {}
                for (s, c, cat), cnt in counts.items():
                    if s == source and c == cid:
                        cat_shares[cat] = round(float(cnt) / denom, 16)
                # Sort by share descending, take top_n
                sorted_cats = sorted(cat_shares.items(), key=lambda x: -x[1])[:top_n]
                out.setdefault(cname, {}).setdefault(source, {})
                for cat, share in sorted_cats:
                    out[cname][source][cat] = share

        return out

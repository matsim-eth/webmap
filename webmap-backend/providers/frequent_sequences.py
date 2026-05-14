from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE
from .connection import get_connection
from .helpers import canton_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


_PURPOSE_CASE = """
    CASE purpose
        WHEN 'home' THEN 'H'
        WHEN 'work' THEN 'W'
        WHEN 'shop' THEN 'S'
        WHEN 'leisure' THEN 'L'
        WHEN 'education' THEN 'E'
        ELSE 'O'
    END
"""


class FrequentSequencesProvider(DataProvider):
    """Frequent activity sequence distribution per canton and source."""

    ROUTE = "frequent_sequences.json"
    PARAMS = [CANTON, SOURCE,
              Param("top_n", "Number of top sequences to return (default 9)", param_type="integer"),
              Param("min_share", "Minimum share threshold to include", param_type="number")]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        top_n = int(params.get("top_n", 9))
        min_share = float(params.get("min_share", 0))

        cf = canton_filter_sql(params.get("canton"), "p.canton_id")

        con = get_connection()

        counts = defaultdict(int)
        totals = defaultdict(int)
        seen_cantons = set()

        if "Synthetic" in sources:
            # Build per-person sequences in SQL using STRING_AGG, then count
            rows = con.execute(f"""
                WITH person_seqs AS (
                    SELECT p.canton_id,
                           STRING_AGG({_PURPOSE_CASE.replace('purpose', 'a.purpose')},
                                      '-' ORDER BY a.activity_index) AS seq
                    FROM read_parquet(?) a
                    INNER JOIN read_parquet(?) p ON a.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL AND a.purpose IS NOT NULL
                    {cf}
                    GROUP BY a.person_id, p.canton_id
                )
                SELECT canton_id, seq, COUNT(*) AS cnt
                FROM person_seqs
                GROUP BY canton_id, seq
            """, [paths.synthetic_activities, paths.synthetic_persons]).fetchall()
            for cid, seq, cnt in rows:
                seen_cantons.add(int(cid))
                counts[("Synthetic", int(cid), str(seq))] += cnt
                totals[("Synthetic", int(cid))] += cnt

        if "Microcensus" in sources:
            # Microcensus: sequence starts with 'H-' then trip purposes
            rows = con.execute(f"""
                WITH person_seqs AS (
                    SELECT p.canton_id,
                           'H-' || STRING_AGG({_PURPOSE_CASE.replace('purpose', 't.purpose')},
                                              '-' ORDER BY t.trip_id) AS seq
                    FROM read_parquet(?) t
                    INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL AND t.purpose IS NOT NULL
                    {cf}
                    GROUP BY t.person_id, p.canton_id
                )
                SELECT canton_id, seq, COUNT(*) AS cnt
                FROM person_seqs
                GROUP BY canton_id, seq
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, seq, cnt in rows:
                seen_cantons.add(int(cid))
                counts[("Microcensus", int(cid), str(seq))] += cnt
                totals[("Microcensus", int(cid))] += cnt

        # "All" canton aggregate
        all_canton_counts = defaultdict(int)
        all_canton_totals = defaultdict(int)
        for (source, cid, seq), cnt in counts.items():
            all_canton_counts[(source, "All", seq)] += cnt
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
                # Collect sequences for this canton+source
                seq_shares = {}
                for (s, c, seq), cnt in counts.items():
                    if s == source and c == cid:
                        share = round(float(cnt) / denom, 16)
                        if share >= min_share:
                            seq_shares[seq] = share
                sorted_seqs = sorted(seq_shares.items(), key=lambda x: -x[1])[:top_n]
                out.setdefault(cname, {}).setdefault(source, {})
                for seq, share in sorted_seqs:
                    out[cname][source][seq] = share

        return out

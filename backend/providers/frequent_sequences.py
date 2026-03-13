import duckdb
from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE
from .helpers import canton_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


PURPOSE_MAP = {"home": "H", "work": "W", "shop": "S", "leisure": "L", "education": "E", "other": "O"}


def _purpose_letter(purpose: str) -> str:
    return PURPOSE_MAP.get(purpose, "O")


class FrequentSequencesProvider(DataProvider):
    """Frequent activity sequence distribution per canton and source.

    Query params:
        canton    (str):   Comma-separated canton names.
        source    (str):   "Synthetic", "Microcensus", or omit for both.
        top_n     (int):   Number of top sequences to return. Default: 9.
        min_share (float): Minimum share threshold to include. Default: 0 (no filter).

    Example: /data/frequent_sequences.json?canton=Zurich&top_n=12
    """

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

        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
        seen_cantons: set = set()

        def tally(source: str, cid: int, seq: str) -> None:
            seen_cantons.add(cid)
            counts[(source, cid, seq)] = counts.get((source, cid, seq), 0) + 1
            totals[(source, cid)] = totals.get((source, cid), 0) + 1
            counts[(source, "All", seq)] = counts.get((source, "All", seq), 0) + 1
            totals[(source, "All")] = totals.get((source, "All"), 0) + 1

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT a.person_id, a.activity_index, a.purpose, p.canton_id
                FROM read_parquet(?) a
                INNER JOIN read_parquet(?) p ON a.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL AND a.purpose IS NOT NULL
                {cf}
                ORDER BY a.person_id, a.activity_index
            """, [paths.synthetic_activities, paths.synthetic_persons]).fetchall()

            # Group by person, build sequence ordered by activity_index
            person_acts: dict[tuple, list[tuple[int, str]]] = defaultdict(list)
            for pid, aidx, purpose, cid in rows:
                person_acts[(int(pid), int(cid))].append((int(aidx), str(purpose)))

            for (pid, cid), acts in person_acts.items():
                acts.sort(key=lambda x: x[0])
                seq = "-".join(_purpose_letter(p) for _, p in acts)
                tally("Synthetic", cid, seq)

        if "Microcensus" in sources:
            rows = con.execute(f"""
                SELECT t.person_id, t.trip_id, t.purpose, p.canton_id
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL AND t.purpose IS NOT NULL
                {cf}
                ORDER BY t.person_id, t.trip_id
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()

            # Group by person, build sequence: start with H, then append purpose of each trip
            person_trips: dict[tuple, list[tuple[int, str]]] = defaultdict(list)
            for pid, tid, purpose, cid in rows:
                person_trips[(int(pid), int(cid))].append((int(tid), str(purpose)))

            for (pid, cid), trips in person_trips.items():
                trips.sort(key=lambda x: x[0])
                seq = "H-" + "-".join(_purpose_letter(p) for _, p in trips)
                tally("Microcensus", cid, seq)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                denom = float(totals.get((source, cid), 0))
                if denom == 0:
                    continue
                # Collect all sequences for this canton+source
                seq_shares = {}
                for (s, c, seq), cnt in counts.items():
                    if s == source and c == cid:
                        share = round(float(cnt) / denom, 16)
                        if share >= min_share:
                            seq_shares[seq] = share
                # Sort by share descending, take top_n
                sorted_seqs = sorted(seq_shares.items(), key=lambda x: -x[1])[:top_n]
                out.setdefault(cname, {}).setdefault(source, {})
                for seq, share in sorted_seqs:
                    out[cname][source][seq] = share

        return out

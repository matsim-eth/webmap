"""Frequent activity-sequence distribution per polygon."""

from __future__ import annotations

from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE
from .connection import get_source_cursor
from .helpers import (
    get_hot_polygon_meta,
    parse_source_param,
)
from ._pre_agg import label_for, make_label_resolver, polygon_filter_clause, resolve_polygon_ids, _source_label


_PURPOSE_CASE = """
    CASE a.purpose
        WHEN 'home' THEN 'H' WHEN 'work' THEN 'W' WHEN 'shop' THEN 'S'
        WHEN 'leisure' THEN 'L' WHEN 'education' THEN 'E'
        ELSE 'O'
    END
"""


class FrequentSequencesProvider(DataProvider):
    ROUTE = "frequent_sequences.json"
    PARAMS = [
        CANTON, SOURCE,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("top_n", "Number of top sequences to return (default 9)", param_type="integer"),
        Param("min_share", "Minimum share threshold", param_type="number"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        try:
            top_n = int(params.get("top_n", 9))
            min_share = float(params.get("min_share", 0))
        except (TypeError, ValueError):
            top_n, min_share = 9, 0.0

        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        counts: dict = defaultdict(int)
        totals: dict = defaultdict(int)
        labels_seen: set = set()

        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            slabel = _source_label(source)

            if polygon_ids:
                join, where, group_expr, bind, _ = polygon_filter_clause(polygon_ids)
                resolve = make_label_resolver(con, polygon_ids,
                                               all(p.startswith("canton:") for p in polygon_ids))
                rows = con.execute(f"""
                    WITH ps AS (
                        SELECT {group_expr} AS poly_key,
                               STRING_AGG({_PURPOSE_CASE}, '-' ORDER BY a.activity_index) AS seq
                        FROM activities a
                        JOIN persons p ON p.person_id = a.person_id
                        {join}
                        WHERE a.purpose IS NOT NULL{where}
                        GROUP BY a.person_id, poly_key
                    )
                    SELECT poly_key, seq, COUNT(*) FROM ps GROUP BY poly_key, seq
                """, bind).fetchall()
                for poly_key, seq, cnt in rows:
                    label = resolve(poly_key)
                    labels_seen.add(label)
                    counts[(label, slabel, str(seq))] += int(cnt)
                    totals[(label, slabel)] += int(cnt)

            rows_all = con.execute(f"""
                WITH ps AS (
                    SELECT a.person_id,
                           STRING_AGG({_PURPOSE_CASE}, '-' ORDER BY a.activity_index) AS seq
                    FROM activities a WHERE a.purpose IS NOT NULL GROUP BY a.person_id
                )
                SELECT seq, COUNT(*) FROM ps GROUP BY seq
            """).fetchall()
            for seq, cnt in rows_all:
                counts[("All", slabel, str(seq))] += int(cnt)
                totals[("All", slabel)] += int(cnt)

        out: dict = {}
        for label in list(labels_seen) + ["All"]:
            for source in sources:
                slabel = _source_label(source)
                denom = float(totals.get((label, slabel), 0))
                if denom == 0:
                    continue
                shares: dict[str, float] = {}
                for (lbl, src, seq), cnt in counts.items():
                    if lbl == label and src == slabel:
                        share = round(cnt / denom, 16)
                        if share >= min_share:
                            shares[seq] = share
                top = sorted(shares.items(), key=lambda x: -x[1])[:top_n]
                out.setdefault(label, {})[slabel] = dict(top)
        return out

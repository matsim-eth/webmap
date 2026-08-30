"""Out-of-home activity-pattern distribution per polygon.

Per person we count their non-home activities by purpose, format the
counts as a short string (e.g. "2W1S" = 2 work + 1 shop), and aggregate
the number of persons that share each pattern. Always raw scan against
``activities``.

Note: the v1 schema's ``out_of_home_grid_500m`` table answers a *different*
question (hourly "people not at home" timeline) and is therefore not
used by this provider.
"""

from __future__ import annotations

from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, GENDER
from .connection import get_source_cursor
from .helpers import (
    gender_filter_sql,
    get_hot_polygon_meta,
    parse_source_param,
)
from ._pre_agg import label_for, make_label_resolver, polygon_filter_clause, primary_fast_path, resolve_polygon_ids, _source_label


_PURPOSE_ABBREV = """
    CASE a.purpose
        WHEN 'work' THEN 'W'
        WHEN 'shop' THEN 'S'
        WHEN 'leisure' THEN 'L'
        WHEN 'education' THEN 'E'
        ELSE 'O'
    END
"""


class OutOfHomeProvider(DataProvider):
    ROUTE = "out_of_home.json"
    PARAMS = [
        CANTON, SOURCE, GENDER,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
        Param("top_n", "Number of top categories to return (default 10)", param_type="integer"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        try:
            top_n = int(params.get("top_n", 10))
        except ValueError:
            top_n = 10
        gf = gender_filter_sql(params, "p.sex")

        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        # counts[(label, source, category)] = count
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
                                               primary_fast_path(polygon_ids))
                rows = con.execute(f"""
                    WITH pp AS (
                        SELECT {group_expr} AS poly_key, a.person_id, a.purpose, COUNT(*) AS cnt
                        FROM activities a
                        JOIN persons p ON p.person_id = a.person_id
                        {join}
                        WHERE a.purpose IS NOT NULL AND a.purpose != 'home'
                        {where}{gf}
                        GROUP BY poly_key, a.person_id, a.purpose
                    ),
                    cats AS (
                        SELECT poly_key,
                               CAST(cnt AS VARCHAR) || {_PURPOSE_ABBREV.replace("a.purpose", "purpose")} AS category
                        FROM pp
                    )
                    SELECT poly_key, category, COUNT(*) FROM cats GROUP BY poly_key, category
                """, bind).fetchall()
                for poly_key, cat, cnt in rows:
                    label = resolve(poly_key)
                    labels_seen.add(label)
                    counts[(label, slabel, str(cat))] += int(cnt)
                    totals[(label, slabel)] += int(cnt)

            rows_all = con.execute(f"""
                WITH pp AS (
                    SELECT a.person_id, a.purpose, COUNT(*) AS cnt
                    FROM activities a
                    JOIN persons p ON p.person_id = a.person_id
                    WHERE a.purpose IS NOT NULL AND a.purpose != 'home'
                    {gf}
                    GROUP BY a.person_id, a.purpose
                ),
                cats AS (
                    SELECT CAST(cnt AS VARCHAR) || {_PURPOSE_ABBREV.replace("a.purpose", "purpose")} AS category
                    FROM pp
                )
                SELECT category, COUNT(*) FROM cats GROUP BY category
            """).fetchall()
            for cat, cnt in rows_all:
                counts[("All", slabel, str(cat))] += int(cnt)
                totals[("All", slabel)] += int(cnt)

        out: dict = {}
        for label in list(labels_seen) + ["All"]:
            for source in sources:
                slabel = _source_label(source)
                denom = float(totals.get((label, slabel), 0))
                if denom == 0:
                    continue
                shares = {
                    cat: round(cnt / denom, 16)
                    for (lbl, src, cat), cnt in counts.items()
                    if lbl == label and src == slabel
                }
                top = sorted(shares.items(), key=lambda x: -x[1])[:top_n]
                out.setdefault(label, {})[slabel] = dict(top)
        return out

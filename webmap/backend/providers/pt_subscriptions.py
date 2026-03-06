import duckdb

from .base import DataProvider
from .constants import SUBS, SUB_LABELS
from .helpers import canton_filter_sql, gender_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


class PtSubscriptionsProvider(DataProvider):
    """PT subscription rates per canton and source.

    Query params:
        canton  (str): Comma-separated canton names.
        source  (str): "Synthetic", "Microcensus", or omit for both.
        gender  (str): "0" or "1" to filter by sex.

    Example: /data/pt_subscriptions.json?canton=Zurich&gender=1
    """

    ROUTE = "pt_subscriptions.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        gf = gender_filter_sql(params)
        cols = ", ".join(f"subscriptions_{s}" for s in SUBS)
        con = duckdb.connect()

        def read_rows(path: str, label: str) -> list[tuple]:
            res = con.execute(
                f"SELECT canton_id, {cols} FROM read_parquet(?) WHERE canton_id IS NOT NULL{cf}{gf}",
                [path],
            ).fetchall()
            return [(label, int(row[0]), row[1:]) for row in res]

        rows: list[tuple] = []
        if "Synthetic" in sources:
            rows.extend(read_rows(paths.synthetic_persons, "Synthetic"))
        if "Microcensus" in sources:
            rows.extend(read_rows(paths.microcensus_persons, "Microcensus"))

        counts: dict = {s: {} for s in SUBS}
        totals: dict = {}
        seen_cantons: set = set()

        for source, cid, sub_vals in rows:
            seen_cantons.add(cid)
            totals[(source, cid)]    = totals.get((source, cid), 0) + 1
            totals[(source, "All")] = totals.get((source, "All"), 0) + 1
            for i, s in enumerate(SUBS):
                if sub_vals[i]:
                    counts[s][(source, cid)]    = counts[s].get((source, cid), 0) + 1
                    counts[s][(source, "All")] = counts[s].get((source, "All"), 0) + 1

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                denom = float(totals.get((source, cid), 0))
                for s in SUBS:
                    num = float(counts[s].get((source, cid), 0))
                    share = round(num / denom, 16) if denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {})[SUB_LABELS[s]] = share

        return out

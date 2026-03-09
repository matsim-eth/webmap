import duckdb

from .base import DataProvider
from .constants import SUBS, SUB_LABELS
from .helpers import canton_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


class PtSubGenderProvider(DataProvider):
    """PT subscription rates broken down by gender.

    Query params:
        canton  (str): Comma-separated canton names.
        source  (str): "Synthetic", "Microcensus", or omit for both.

    Example: /data/pt_sub_gender.json?canton=Zurich&source=Synthetic
    """

    ROUTE = "pt_sub_gender.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        cols = ", ".join(f"subscriptions_{s}" for s in SUBS)
        con = duckdb.connect()

        def read_rows(path: str, label: str) -> list[tuple]:
            res = con.execute(
                f"SELECT canton_id, sex, {cols} FROM read_parquet(?) WHERE canton_id IS NOT NULL AND sex IS NOT NULL{cf}",
                [path],
            ).fetchall()
            rows = []
            for row in res:
                cid, sex = row[0], row[1]
                sub_vals = row[2:]
                try:
                    g = str(int(sex))
                except Exception:
                    continue
                rows.append((label, int(cid), g, sub_vals))
            return rows

        rows: list[tuple] = []
        if "Synthetic" in sources:
            rows.extend(read_rows(paths.synthetic_persons, "Synthetic"))
        if "Microcensus" in sources:
            rows.extend(read_rows(paths.microcensus_persons, "Microcensus"))

        counts: dict = {s: {} for s in SUBS}
        totals: dict = {}
        seen_cantons: set = set()
        seen_genders: set = set()

        for source, cid, g, sub_vals in rows:
            seen_cantons.add(cid)
            seen_genders.add(g)
            totals[(source, cid, g)]    = totals.get((source, cid, g), 0) + 1
            totals[(source, "All", g)] = totals.get((source, "All", g), 0) + 1
            for i, s in enumerate(SUBS):
                if sub_vals[i]:
                    counts[s][(source, cid, g)]    = counts[s].get((source, cid, g), 0) + 1
                    counts[s][(source, "All", g)] = counts[s].get((source, "All", g), 0) + 1

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        genders = sorted(seen_genders)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for g in genders:
                    denom = float(totals.get((source, cid, g), 0))
                    for s in SUBS:
                        num = float(counts[s].get((source, cid, g), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(g, {})[SUB_LABELS[s]] = share

        return out

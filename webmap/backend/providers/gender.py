import duckdb

from .base import DataProvider
from .helpers import canton_filter_sql, age_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


class GenderProvider(DataProvider):
    """Gender distribution per canton and source.

    Query params:
        canton  (str): Comma-separated canton names.
        source  (str): "Synthetic", "Microcensus", or omit for both.
        age_min (int): Minimum age (inclusive).
        age_max (int): Maximum age (exclusive).

    Example: /data/gender.json?canton=Zurich&age_min=18&age_max=65
    """

    ROUTE = "gender.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        af = age_filter_sql(params)
        con = duckdb.connect()

        def read_rows(path: str, label: str) -> list[tuple]:
            res = con.execute(
                f"SELECT sex, canton_id FROM read_parquet(?) WHERE canton_id IS NOT NULL AND sex IS NOT NULL{cf}{af}",
                [path],
            ).fetchall()
            rows = []
            for g, cid in res:
                try:
                    g = int(g)
                except Exception:
                    continue
                if g not in (0, 1):
                    continue
                rows.append((label, int(cid), str(g)))
            return rows

        rows: list[tuple] = []
        if "Synthetic" in sources:
            rows.extend(read_rows(paths.synthetic_persons, "Synthetic"))
        if "Microcensus" in sources:
            rows.extend(read_rows(paths.microcensus_persons, "Microcensus"))

        counts: dict = {}
        totals: dict = {}

        for source, cid, g_label in rows:
            counts[(source, cid, g_label)] = counts.get((source, cid, g_label), 0) + 1
            totals[(source, cid)] = totals.get((source, cid), 0) + 1
            counts[(source, "All", g_label)] = counts.get((source, "All", g_label), 0) + 1
            totals[(source, "All")] = totals.get((source, "All"), 0) + 1

        seen_cantons = {cid for (_, cid, _) in rows if cid != "All"}
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

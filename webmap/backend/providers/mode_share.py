import duckdb

from .base import DataProvider
from .constants import canton_name
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    age_filter_sql,
    parse_source_param,
    build_canton_lookup,
    mode_filter_sql,
)
from .paths import get_data_paths


class ModeShareProvider(DataProvider):
    """Mode share per canton and source.

    Query params:
        canton  (str): Comma-separated canton names.
        source  (str): "Synthetic", "Microcensus", or omit for both.
        mode    (str): Comma-separated transport modes to include.
        gender  (str): "0" or "1" to filter by sex.
        age_min (int): Minimum age (inclusive).
        age_max (int): Maximum age (exclusive).

    Example: /data/mode_share.json?canton=Zurich&source=Synthetic&mode=car,bike&gender=1&age_min=18&age_max=65
    """

    ROUTE = "mode_share.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        mf = mode_filter_sql(params, "t.mode")
        gf = gender_filter_sql(params, "p.sex")
        af = age_filter_sql(params, "p.age")
        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
        seen_cantons: set = set()

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, t.mode
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL AND t.mode IS NOT NULL
                {cf}{mf}{gf}{af}
            """, [paths.synthetic_trips, paths.synthetic_persons]).fetchall()
            for cid, mode in rows:
                cid = int(cid)
                mode = str(mode)
                seen_cantons.add(cid)
                counts[("Synthetic", cid, mode)] = counts.get(("Synthetic", cid, mode), 0) + 1
                totals[("Synthetic", cid)] = totals.get(("Synthetic", cid), 0) + 1
                counts[("Synthetic", "All", mode)] = counts.get(("Synthetic", "All", mode), 0) + 1
                totals[("Synthetic", "All")] = totals.get(("Synthetic", "All"), 0) + 1

        if "Microcensus" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, t.mode
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL AND t.mode IS NOT NULL
                {cf}{mf}{gf}{af}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, mode in rows:
                cid = int(cid)
                mode = str(mode)
                seen_cantons.add(cid)
                counts[("Microcensus", cid, mode)] = counts.get(("Microcensus", cid, mode), 0) + 1
                totals[("Microcensus", cid)] = totals.get(("Microcensus", cid), 0) + 1
                counts[("Microcensus", "All", mode)] = counts.get(("Microcensus", "All", mode), 0) + 1
                totals[("Microcensus", "All")] = totals.get(("Microcensus", "All"), 0) + 1

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        modes = sorted({k[2] for k in counts.keys()})

        result: dict = {}
        max_share_per_mode: dict = {}

        for source in sources:
            source_rows = []
            for cname in canton_names + ["All"]:
                cid = canton_ids_by_name.get(cname, "All")
                denom = float(totals.get((source, cid), 0))
                for mode in modes:
                    num = float(counts.get((source, cid, mode), 0))
                    share = round(num / denom, 8) if denom > 0 else 0.0
                    source_rows.append({
                        "canton_name": cname,
                        "mode": mode,
                        "share": share,
                    })
                    if cname != "All":
                        max_share_per_mode[mode] = max(
                            max_share_per_mode.get(mode, 0.0), share
                        )
            result[source] = source_rows

        result["max_share_per_mode"] = max_share_per_mode
        return result

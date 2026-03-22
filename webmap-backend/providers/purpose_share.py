from .base import DataProvider, CANTON, SOURCE, GENDER, MODE, PURPOSE
from .connection import get_connection
from .constants import canton_name
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    parse_source_param,
    build_canton_lookup,
    mode_filter_sql,
    purpose_filter_sql,
)
from .paths import get_data_paths


class PurposeShareProvider(DataProvider):
    """Purpose share per canton and source.

    Query params:
        canton  (str): Comma-separated canton names.
        source  (str): "Synthetic", "Microcensus", or omit for both.
        purpose (str): Comma-separated purposes to include.
        mode    (str): Comma-separated transport modes to include.
        gender  (str): "0" or "1" to filter by sex.

    Example: /data/purpose_share.json?canton=Zurich&source=Synthetic&purpose=work,education&mode=car&gender=0
    """

    ROUTE = "purpose_share.json"
    PARAMS = [CANTON, SOURCE, GENDER, MODE, PURPOSE]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        mf = mode_filter_sql(params, "t.mode")
        gf = gender_filter_sql(params, "p.sex")
        con = get_connection()

        counts: dict = {}
        totals: dict = {}
        seen_cantons: set = set()

        if "Synthetic" in sources:
            pf = purpose_filter_sql(params, "t.preceding_purpose")
            rows = con.execute(f"""
                SELECT p.canton_id, t.preceding_purpose
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL AND t.preceding_purpose IS NOT NULL
                {cf}{pf}{mf}{gf}
            """, [paths.synthetic_trips, paths.synthetic_persons]).fetchall()
            for cid, purpose in rows:
                cid = int(cid)
                purpose = str(purpose)
                seen_cantons.add(cid)
                counts[("Synthetic", cid, purpose)] = counts.get(("Synthetic", cid, purpose), 0) + 1
                totals[("Synthetic", cid)] = totals.get(("Synthetic", cid), 0) + 1
                counts[("Synthetic", "All", purpose)] = counts.get(("Synthetic", "All", purpose), 0) + 1
                totals[("Synthetic", "All")] = totals.get(("Synthetic", "All"), 0) + 1

        if "Microcensus" in sources:
            pf = purpose_filter_sql(params, "t.purpose")
            rows = con.execute(f"""
                SELECT p.canton_id, t.purpose
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL AND t.purpose IS NOT NULL
                {cf}{pf}{mf}{gf}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, purpose in rows:
                cid = int(cid)
                purpose = str(purpose)
                seen_cantons.add(cid)
                counts[("Microcensus", cid, purpose)] = counts.get(("Microcensus", cid, purpose), 0) + 1
                totals[("Microcensus", cid)] = totals.get(("Microcensus", cid), 0) + 1
                counts[("Microcensus", "All", purpose)] = counts.get(("Microcensus", "All", purpose), 0) + 1
                totals[("Microcensus", "All")] = totals.get(("Microcensus", "All"), 0) + 1

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        purposes = sorted({k[2] for k in counts.keys()})

        result: dict = {}
        max_share_per_purpose: dict = {}

        for source in sources:
            source_rows = []
            for cname in canton_names + ["All"]:
                cid = canton_ids_by_name.get(cname, "All")
                denom = float(totals.get((source, cid), 0))
                for purpose in purposes:
                    num = float(counts.get((source, cid, purpose), 0))
                    share = round(num / denom, 8) if denom > 0 else 0.0
                    source_rows.append({
                        "canton_name": cname,
                        "purpose": purpose,
                        "share": share,
                    })
                    if cname != "All":
                        max_share_per_purpose[purpose] = max(
                            max_share_per_purpose.get(purpose, 0.0), share
                        )
            result[source] = source_rows

        result["max_share_per_purpose"] = max_share_per_purpose
        return result

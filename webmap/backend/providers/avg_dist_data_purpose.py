import duckdb

from .base import DataProvider
from .constants import canton_name
from .helpers import (
    canton_filter_sql,
    parse_source_param,
    build_canton_lookup,
    mode_filter_sql,
    purpose_filter_sql,
)
from .paths import get_data_paths


class AvgDistDataPurposeProvider(DataProvider):
    """Average distance data grouped by purpose, per canton and source.

    Query params:
        canton  (str): Comma-separated canton names.
        source  (str): "Synthetic", "Microcensus", or omit for both.
        purpose (str): Comma-separated purposes to include.
        mode    (str): Comma-separated transport modes to include.

    Example: /data/avg_dist_data_purpose.json?canton=Zurich&source=Microcensus&purpose=work,education&mode=car
    """

    ROUTE = "avg_dist_data_purpose.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        mf_micro = mode_filter_sql(params, "t.mode")
        mf_synth = mode_filter_sql(params, "t.main_mode")
        con = duckdb.connect()

        # key: (source, canton_id_or_"All", purpose) -> {euc_sum, net_sum, count}
        agg: dict = {}
        seen_cantons: set = set()

        def accumulate(source: str, cid, purpose: str, euc: float, net: float) -> None:
            cid = int(cid)
            purpose = str(purpose)
            seen_cantons.add(cid)
            for c in (cid, "All"):
                key = (source, c, purpose)
                bucket = agg.setdefault(key, {"euc_sum": 0.0, "net_sum": 0.0, "count": 0})
                bucket["euc_sum"] += euc
                bucket["net_sum"] += net
                bucket["count"] += 1

        if "Microcensus" in sources:
            pf = purpose_filter_sql(params, "t.purpose")
            rows = con.execute(f"""
                SELECT p.canton_id, t.purpose,
                       t.crowfly_distance, t.network_distance
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.purpose IS NOT NULL
                  AND t.crowfly_distance IS NOT NULL
                  AND t.network_distance IS NOT NULL
                {cf}{pf}{mf_micro}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, purpose, euc, net in rows:
                accumulate("Microcensus", cid, purpose, float(euc), float(net))

        if "Synthetic" in sources:
            pf = purpose_filter_sql(params, "t.end_activity_type")
            rows = con.execute(f"""
                SELECT p.canton_id, t.end_activity_type,
                       t.euclidean_distance, t.traveled_distance
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p
                    ON TRY_CAST(t.person AS BIGINT) = p.person_id
                WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                  AND p.canton_id IS NOT NULL
                  AND t.end_activity_type IS NOT NULL
                  AND t.euclidean_distance IS NOT NULL
                  AND t.traveled_distance IS NOT NULL
                {cf}{pf}{mf_synth}
            """, [paths.synthetic_output_trips, paths.synthetic_persons]).fetchall()
            for cid, purpose, euc, net in rows:
                accumulate("Synthetic", cid, purpose, float(euc), float(net))

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        result: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            canton_data: dict = {}
            for source in sources:
                source_data: dict = {}
                for (s, c, purpose), bucket in agg.items():
                    if s != source or c != cid:
                        continue
                    source_data[purpose] = {
                        "euclidean_distance": round(bucket["euc_sum"] / bucket["count"], 2),
                        "network_distance": round(bucket["net_sum"] / bucket["count"], 2),
                        "sample_size": bucket["count"],
                    }
                if source_data:
                    canton_data[source] = source_data
            if canton_data:
                result[cname] = canton_data

        return result

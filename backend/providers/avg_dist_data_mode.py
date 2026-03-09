import duckdb

from .base import DataProvider
from .constants import canton_name
from .helpers import (
    canton_filter_sql,
    parse_source_param,
    build_canton_lookup,
    mode_filter_sql,
)
from .paths import get_data_paths


class AvgDistDataModeProvider(DataProvider):
    """Average distance data grouped by mode, per canton and source.

    Query params:
        canton          (str): Comma-separated canton names.
        source          (str): "Synthetic", "Microcensus", or omit for both.
        mode            (str): Comma-separated transport modes to include.
        min_sample_size (int): Skip groups with fewer samples than this value.

    Example: /data/avg_dist_data_mode.json?canton=Zurich&source=Microcensus&mode=car,bike&min_sample_size=50
    """

    ROUTE = "avg_dist_data_mode.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        mf_micro = mode_filter_sql(params, "t.mode")
        mf_synth = mode_filter_sql(params, "t.main_mode")
        con = duckdb.connect()

        try:
            min_sample = int(params.get("min_sample_size", 0))
        except ValueError:
            min_sample = 0

        # key: (source, canton_id_or_"All", mode) -> {euc_sum, net_sum, count}
        agg: dict = {}
        seen_cantons: set = set()

        def accumulate(source: str, cid, mode: str, euc: float, net: float) -> None:
            cid = int(cid)
            mode = str(mode)
            seen_cantons.add(cid)
            for c in (cid, "All"):
                key = (source, c, mode)
                bucket = agg.setdefault(key, {"euc_sum": 0.0, "net_sum": 0.0, "count": 0})
                bucket["euc_sum"] += euc
                bucket["net_sum"] += net
                bucket["count"] += 1

        if "Microcensus" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, t.mode,
                       t.crowfly_distance, t.network_distance
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.mode IS NOT NULL
                  AND t.crowfly_distance IS NOT NULL
                  AND t.network_distance IS NOT NULL
                {cf}{mf_micro}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, mode, euc, net in rows:
                accumulate("Microcensus", cid, mode, float(euc), float(net))

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, t.main_mode,
                       t.euclidean_distance, t.traveled_distance
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p
                    ON TRY_CAST(t.person AS BIGINT) = p.person_id
                WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                  AND p.canton_id IS NOT NULL
                  AND t.main_mode IS NOT NULL
                  AND t.euclidean_distance IS NOT NULL
                  AND t.traveled_distance IS NOT NULL
                {cf}{mf_synth}
            """, [paths.synthetic_output_trips, paths.synthetic_persons]).fetchall()
            for cid, mode, euc, net in rows:
                accumulate("Synthetic", cid, mode, float(euc), float(net))

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        result: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            canton_data: dict = {}
            for source in sources:
                source_data: dict = {}
                for (s, c, mode), bucket in agg.items():
                    if s != source or c != cid:
                        continue
                    if bucket["count"] < min_sample:
                        continue
                    source_data[mode] = {
                        "euclidean_distance": round(bucket["euc_sum"] / bucket["count"], 2),
                        "network_distance": round(bucket["net_sum"] / bucket["count"], 2),
                        "sample_size": bucket["count"],
                    }
                if source_data:
                    canton_data[source] = source_data
            if canton_data:
                result[cname] = canton_data

        return result

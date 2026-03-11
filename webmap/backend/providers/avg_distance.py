"""Average distance data grouped by mode or purpose.

Consolidates the former 2 endpoints into 1:
  avg_dist_data_mode.json    -> ?group_by=mode
  avg_dist_data_purpose.json -> ?group_by=purpose

Query params
------------
group_by        (str): "mode" (default) or "purpose".
canton          (str): Comma-separated canton names.
source          (str): "Synthetic", "Microcensus", or omit for both.
mode            (str): Comma-separated transport modes to include.
purpose         (str): Comma-separated purposes to include.
min_sample_size (int): Skip groups with fewer samples than this value.
gender          (str): "0" or "1" to filter by sex.
age_min         (int): Minimum age (inclusive).
age_max         (int): Maximum age (exclusive).
"""

import duckdb

from .base import DataProvider
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    age_filter_sql,
    parse_source_param,
    build_canton_lookup,
    mode_filter_sql,
    purpose_filter_sql,
)
from .paths import get_data_paths


class AvgDistanceProvider(DataProvider):
    ROUTE = "avg_distance.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = gender_filter_sql(params, "p.sex")
        af = age_filter_sql(params, "p.age")
        con = duckdb.connect()

        group_by = params.get("group_by", "mode").lower()
        if group_by not in ("mode", "purpose"):
            group_by = "mode"

        try:
            min_sample = int(params.get("min_sample_size", 0))
        except ValueError:
            min_sample = 0

        # Column mapping per group_by and source
        if group_by == "mode":
            mc_group_col = "t.mode"
            syn_group_col = "t.main_mode"
            mc_gf = mode_filter_sql(params, mc_group_col)
            syn_gf = mode_filter_sql(params, syn_group_col)
        else:
            mc_group_col = "t.purpose"
            syn_group_col = "t.end_activity_type"
            mc_gf = purpose_filter_sql(params, mc_group_col)
            syn_gf = purpose_filter_sql(params, syn_group_col)

        # Also allow cross-filter: mode filter when group_by=purpose and vice versa
        if group_by == "purpose":
            mc_gf += mode_filter_sql(params, "t.mode")
            syn_gf += mode_filter_sql(params, "t.main_mode")
        else:
            mc_gf += purpose_filter_sql(params, "t.purpose")
            syn_gf += purpose_filter_sql(params, "t.end_activity_type")

        agg: dict = {}
        seen_cantons: set = set()

        def accumulate(source: str, cid, group_val: str, euc: float, net: float) -> None:
            cid = int(cid)
            seen_cantons.add(cid)
            for c in (cid, "All"):
                key = (source, c, group_val)
                bucket = agg.setdefault(key, {"euc_sum": 0.0, "net_sum": 0.0, "count": 0})
                bucket["euc_sum"] += euc
                bucket["net_sum"] += net
                bucket["count"] += 1

        if "Microcensus" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, {mc_group_col},
                       t.crowfly_distance, t.network_distance
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND {mc_group_col} IS NOT NULL
                  AND t.crowfly_distance IS NOT NULL
                  AND t.network_distance IS NOT NULL
                {cf}{mc_gf}{gf}{af}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, grp, euc, net in rows:
                accumulate("Microcensus", cid, str(grp), float(euc), float(net))

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, {syn_group_col},
                       t.euclidean_distance, t.traveled_distance
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p
                    ON TRY_CAST(t.person AS BIGINT) = p.person_id
                WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                  AND p.canton_id IS NOT NULL
                  AND {syn_group_col} IS NOT NULL
                  AND t.euclidean_distance IS NOT NULL
                  AND t.traveled_distance IS NOT NULL
                {cf}{syn_gf}{gf}{af}
            """, [paths.synthetic_output_trips, paths.synthetic_persons]).fetchall()
            for cid, grp, euc, net in rows:
                accumulate("Synthetic", cid, str(grp), float(euc), float(net))

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        result: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            canton_data: dict = {}
            for source in sources:
                source_data: dict = {}
                for (s, c, grp), bucket in agg.items():
                    if s != source or c != cid:
                        continue
                    if bucket["count"] < min_sample:
                        continue
                    source_data[grp] = {
                        "euclidean_distance": round(bucket["euc_sum"] / bucket["count"], 2),
                        "network_distance": round(bucket["net_sum"] / bucket["count"], 2),
                        "sample_size": bucket["count"],
                    }
                if source_data:
                    canton_data[source] = source_data
            if canton_data:
                result[cname] = canton_data

        return result

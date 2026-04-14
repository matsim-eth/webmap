"""Average distance data grouped by mode or purpose."""

from collections import defaultdict

from .base import DataProvider, Param, TRIP_FILTERS, SUMMARY_ONLY
from .connection import get_connection
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    age_filter_sql,
    parse_source_param,
    build_canton_lookup,
    mode_filter_sql,
    purpose_filter_sql,
    is_summary_only,
    has_person_filters,
)
from .paths import get_data_paths


class AvgDistanceProvider(DataProvider):
    ROUTE = "avg_distance.json"
    PARAMS = TRIP_FILTERS + [
        SUMMARY_ONLY,
        Param("group_by", "Group results by 'mode' (default) or 'purpose'", enum=["mode", "purpose"]),
        Param("min_sample_size", "Skip groups with fewer samples", param_type="integer"),
    ]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        summary = is_summary_only(params) and not params.get("canton") and not has_person_filters(params)
        cf = "" if summary else canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = "" if summary else gender_filter_sql(params, "p.sex")
        af = "" if summary else age_filter_sql(params, "p.age")
        con = get_connection()

        group_by = params.get("group_by", "mode").lower()
        if group_by not in ("mode", "purpose"):
            group_by = "mode"

        try:
            min_sample = int(params.get("min_sample_size", 0))
        except ValueError:
            min_sample = 0

        if group_by == "mode":
            mc_group_col = "t.mode"
            syn_group_col = "t.main_mode"
            mc_gf = mode_filter_sql(params, mc_group_col) + purpose_filter_sql(params, "t.purpose")
            syn_gf = mode_filter_sql(params, syn_group_col) + purpose_filter_sql(params, "t.end_activity_type")
        else:
            mc_group_col = "t.purpose"
            syn_group_col = "t.end_activity_type"
            mc_gf = purpose_filter_sql(params, mc_group_col) + mode_filter_sql(params, "t.mode")
            syn_gf = purpose_filter_sql(params, syn_group_col) + mode_filter_sql(params, "t.main_mode")

        # agg[(source, cid, group_val)] = {euc_sum, net_sum, count}
        agg = defaultdict(lambda: {"euc_sum": 0.0, "net_sum": 0.0, "count": 0})
        seen_cantons = set()

        if "Microcensus" in sources:
            if summary:
                rows = con.execute(f"""
                    SELECT {mc_group_col} AS grp,
                           SUM(t.crowfly_distance) AS euc_sum,
                           SUM(t.network_distance) AS net_sum,
                           COUNT(*) AS cnt
                    FROM read_parquet(?) t
                    WHERE {mc_group_col} IS NOT NULL
                      AND t.crowfly_distance IS NOT NULL
                      AND t.network_distance IS NOT NULL
                    {mc_gf}
                    GROUP BY grp
                """, [paths.microcensus_trips]).fetchall()
                for grp, euc, net, cnt in rows:
                    key = ("Microcensus", "All", str(grp))
                    agg[key]["euc_sum"] += float(euc)
                    agg[key]["net_sum"] += float(net)
                    agg[key]["count"] += int(cnt)
            else:
                rows = con.execute(f"""
                    SELECT p.canton_id, {mc_group_col} AS grp,
                           SUM(t.crowfly_distance) AS euc_sum,
                           SUM(t.network_distance) AS net_sum,
                           COUNT(*) AS cnt
                    FROM read_parquet(?) t
                    INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL
                      AND {mc_group_col} IS NOT NULL
                      AND t.crowfly_distance IS NOT NULL
                      AND t.network_distance IS NOT NULL
                    {cf}{mc_gf}{gf}{af}
                    GROUP BY p.canton_id, grp
                """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
                for cid, grp, euc, net, cnt in rows:
                    seen_cantons.add(int(cid))
                    key = ("Microcensus", int(cid), str(grp))
                    agg[key]["euc_sum"] += float(euc)
                    agg[key]["net_sum"] += float(net)
                    agg[key]["count"] += int(cnt)

        if "Synthetic" in sources:
            if summary:
                rows = con.execute(f"""
                    SELECT {syn_group_col} AS grp,
                           SUM(t.euclidean_distance) AS euc_sum,
                           SUM(t.traveled_distance) AS net_sum,
                           COUNT(*) AS cnt
                    FROM read_parquet(?) t
                    WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                      AND {syn_group_col} IS NOT NULL
                      AND t.euclidean_distance IS NOT NULL
                      AND t.traveled_distance IS NOT NULL
                    {syn_gf}
                    GROUP BY grp
                """, [paths.synthetic_output_trips]).fetchall()
                for grp, euc, net, cnt in rows:
                    key = ("Synthetic", "All", str(grp))
                    agg[key]["euc_sum"] += float(euc)
                    agg[key]["net_sum"] += float(net)
                    agg[key]["count"] += int(cnt)
            else:
                rows = con.execute(f"""
                    SELECT p.canton_id, {syn_group_col} AS grp,
                           SUM(t.euclidean_distance) AS euc_sum,
                           SUM(t.traveled_distance) AS net_sum,
                           COUNT(*) AS cnt
                    FROM read_parquet(?) t
                    INNER JOIN read_parquet(?) p
                        ON TRY_CAST(t.person AS BIGINT) = p.person_id
                    WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                      AND p.canton_id IS NOT NULL
                      AND {syn_group_col} IS NOT NULL
                      AND t.euclidean_distance IS NOT NULL
                      AND t.traveled_distance IS NOT NULL
                    {cf}{syn_gf}{gf}{af}
                    GROUP BY p.canton_id, grp
                """, [paths.synthetic_output_trips, paths.synthetic_persons]).fetchall()
                for cid, grp, euc, net, cnt in rows:
                    seen_cantons.add(int(cid))
                    key = ("Synthetic", int(cid), str(grp))
                    agg[key]["euc_sum"] += float(euc)
                    agg[key]["net_sum"] += float(net)
                    agg[key]["count"] += int(cnt)

        # "All" canton aggregate (skip in summary mode — already accumulated under "All")
        if not summary:
            all_canton = defaultdict(lambda: {"euc_sum": 0.0, "net_sum": 0.0, "count": 0})
            for (source, cid, grp), bucket in agg.items():
                ak = (source, "All", grp)
                all_canton[ak]["euc_sum"] += bucket["euc_sum"]
                all_canton[ak]["net_sum"] += bucket["net_sum"]
                all_canton[ak]["count"] += bucket["count"]
            agg.update(all_canton)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        result: dict = {}
        canton_list = ["All"] if summary else canton_names + ["All"]
        for cname in canton_list:
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

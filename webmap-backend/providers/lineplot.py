"""Lineplot provider for departure time and distance distributions.

Consolidates the former 6 endpoints into 1:
  lineplot_departure_time_data_mode.json         -> ?metric=departure_time&group_by=mode
  lineplot_departure_time_data_purpose.json       -> ?metric=departure_time&group_by=purpose
  lineplot_euclidean_distance_data_mode.json      -> ?metric=euclidean_distance&group_by=mode
  lineplot_euclidean_distance_data_purpose.json   -> ?metric=euclidean_distance&group_by=purpose
  lineplot_network_distance_data_mode.json        -> ?metric=network_distance&group_by=mode
  lineplot_network_distance_data_purpose.json     -> ?metric=network_distance&group_by=purpose

Query params
------------
metric    (str): "departure_time" (default), "euclidean_distance", or "network_distance".
group_by  (str): "mode" (default) or "purpose".
canton    (str): Comma-separated canton names.
source    (str): "Synthetic", "Microcensus", or omit for both.
mode      (str): Comma-separated transport modes to include.
purpose   (str): Comma-separated purposes to include.
num_bins  (int): Number of bins (default 32).
max_value (float): Upper bound (hours for time, km for distance). Auto for distance.
gender    (str): "0" or "1" to filter by sex.
age_min   (int): Minimum age (inclusive).
age_max   (int): Maximum age (exclusive).
"""

from .base import DataProvider, Param, TRIP_FILTERS
from .connection import get_connection
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    age_filter_sql,
    parse_source_param,
    mode_filter_sql,
    purpose_filter_sql,
)
from .lineplot_base import build_lineplot
from .paths import get_data_paths


# Column configurations per metric and source
# (trip_table_attr, value_expr, join_expr)
_METRIC_CONFIG = {
    "departure_time": {
        "mc": {
            "table_attr": "microcensus_trips",
            "value_expr": "t.departure_time / 3600.0",
            "value_null_check": "t.departure_time",
            "join_expr": "t.person_id = p.person_id",
            "group_cols": {"mode": "t.mode", "purpose": "t.purpose"},
        },
        "syn": {
            "table_attr": "synthetic_trips",
            "value_expr": "t.departure_time / 3600.0",
            "value_null_check": "t.departure_time",
            "join_expr": "t.person_id = p.person_id",
            "group_cols": {"mode": "t.mode", "purpose": "t.preceding_purpose"},
        },
        "tick_fn": "departure_time",
        "default_max": 30.0,
    },
    "euclidean_distance": {
        "mc": {
            "table_attr": "microcensus_trips",
            "value_expr": "t.crowfly_distance / 1000.0",
            "value_null_check": "t.crowfly_distance",
            "join_expr": "t.person_id = p.person_id",
            "group_cols": {"mode": "t.mode", "purpose": "t.purpose"},
        },
        "syn": {
            "table_attr": "synthetic_output_trips",
            "value_expr": "t.euclidean_distance / 1000.0",
            "value_null_check": "t.euclidean_distance",
            "join_expr": "TRY_CAST(t.person AS BIGINT) = p.person_id",
            "group_cols": {"mode": "t.main_mode", "purpose": "t.end_activity_type"},
        },
        "tick_fn": "distance",
        "default_max": None,
    },
    "network_distance": {
        "mc": {
            "table_attr": "microcensus_trips",
            "value_expr": "t.network_distance / 1000.0",
            "value_null_check": "t.network_distance",
            "join_expr": "t.person_id = p.person_id",
            "group_cols": {"mode": "t.mode", "purpose": "t.purpose"},
        },
        "syn": {
            "table_attr": "synthetic_output_trips",
            "value_expr": "t.traveled_distance / 1000.0",
            "value_null_check": "t.traveled_distance",
            "join_expr": "TRY_CAST(t.person AS BIGINT) = p.person_id",
            "group_cols": {"mode": "t.main_mode", "purpose": "t.end_activity_type"},
        },
        "tick_fn": "distance",
        "default_max": None,
    },
}

# Person tables per source
_PERSON_TABLES = {
    "mc": "microcensus_persons",
    "syn": "synthetic_persons",
}


class LineplotProvider(DataProvider):
    ROUTE = "lineplot.json"
    PARAMS = TRIP_FILTERS + [
        Param("metric", "Value to plot", enum=["departure_time", "euclidean_distance", "network_distance"]),
        Param("group_by", "Group results by 'mode' (default) or 'purpose'", enum=["mode", "purpose"]),
        Param("num_bins", "Number of bins (default 32)", param_type="integer"),
        Param("max_value", "Upper bound (hours for time, km for distance)", param_type="number"),
    ]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = gender_filter_sql(params, "p.sex")
        af = age_filter_sql(params, "p.age")

        metric = params.get("metric", "departure_time").lower()
        group_by = params.get("group_by", "mode").lower()

        if metric not in _METRIC_CONFIG:
            metric = "departure_time"
        if group_by not in ("mode", "purpose"):
            group_by = "mode"

        config = _METRIC_CONFIG[metric]

        try:
            num_bins = int(params.get("num_bins", 32))
        except ValueError:
            num_bins = 32

        max_value_param = params.get("max_value")
        if max_value_param:
            try:
                max_value = float(max_value_param)
            except ValueError:
                max_value = config["default_max"]
        else:
            max_value = config["default_max"]

        con = get_connection()

        mc_rows = None
        syn_rows = None

        if "Microcensus" in sources:
            mc = config["mc"]
            trip_path = getattr(paths, mc["table_attr"])
            person_path = getattr(paths, _PERSON_TABLES["mc"])
            group_col = mc["group_cols"][group_by]

            if group_by == "mode":
                extra = mode_filter_sql(params, group_col)
            else:
                extra = purpose_filter_sql(params, group_col)

            # Handle TRY_CAST join for synthetic
            join_null = ""
            if "TRY_CAST" in mc["join_expr"]:
                join_null = "AND TRY_CAST(t.person AS BIGINT) IS NOT NULL\n"

            raw = con.execute(f"""
                SELECT p.canton_id, {group_col},
                       {mc['value_expr']} AS val
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON {mc['join_expr']}
                WHERE p.canton_id IS NOT NULL
                  AND {group_col} IS NOT NULL
                  AND {mc['value_null_check']} IS NOT NULL
                  {join_null}
                {cf}{extra}{gf}{af}
            """, [trip_path, person_path]).fetchall()
            mc_rows = [(cid, grp, float(v)) for cid, grp, v in raw]

        if "Synthetic" in sources:
            syn = config["syn"]
            trip_path = getattr(paths, syn["table_attr"])
            person_path = getattr(paths, _PERSON_TABLES["syn"])
            group_col = syn["group_cols"][group_by]

            if group_by == "mode":
                extra = mode_filter_sql(params, group_col)
            else:
                extra = purpose_filter_sql(params, group_col)

            join_null = ""
            if "TRY_CAST" in syn["join_expr"]:
                join_null = "AND TRY_CAST(t.person AS BIGINT) IS NOT NULL\n"

            raw = con.execute(f"""
                SELECT p.canton_id, {group_col},
                       {syn['value_expr']} AS val
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON {syn['join_expr']}
                WHERE p.canton_id IS NOT NULL
                  AND {group_col} IS NOT NULL
                  AND {syn['value_null_check']} IS NOT NULL
                  {join_null}
                {cf}{extra}{gf}{af}
            """, [trip_path, person_path]).fetchall()
            syn_rows = [(cid, grp, float(v)) for cid, grp, v in raw]

        return build_lineplot(
            microcensus_rows=mc_rows,
            synthetic_rows=syn_rows,
            group_key=group_by,
            num_bins=num_bins,
            max_value=max_value,
            tick_fn=config["tick_fn"],
        )

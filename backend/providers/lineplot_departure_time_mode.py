import duckdb

from .base import DataProvider
from .helpers import (
    canton_filter_sql,
    parse_source_param,
    mode_filter_sql,
)
from .lineplot_base import build_lineplot
from .paths import get_data_paths


class LineplotDepartureTimeModeProvider(DataProvider):
    """Departure-time lineplot grouped by transport mode.

    Query params:
        canton   (str): Comma-separated canton names.
        source   (str): "Synthetic", "Microcensus", or omit for both.
        mode     (str): Comma-separated transport modes to include.
        num_bins (int): Number of bins (default 32).
        max_value(float): Upper bound in hours (default 30).
    """

    ROUTE = "lineplot_departure_time_data_mode.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        num_bins = int(params.get("num_bins", 32))
        max_value = float(params.get("max_value", 30))
        con = duckdb.connect()

        mc_rows = None
        syn_rows = None

        if "Microcensus" in sources:
            mf = mode_filter_sql(params, "t.mode")
            raw = con.execute(f"""
                SELECT p.canton_id, t.mode,
                       t.departure_time / 3600.0 AS dep_hours
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.mode IS NOT NULL
                  AND t.departure_time IS NOT NULL
                {cf}{mf}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            mc_rows = [(cid, mode, float(h)) for cid, mode, h in raw]

        if "Synthetic" in sources:
            mf = mode_filter_sql(params, "t.mode")
            raw = con.execute(f"""
                SELECT p.canton_id, t.mode,
                       t.departure_time / 3600.0 AS dep_hours
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.mode IS NOT NULL
                  AND t.departure_time IS NOT NULL
                {cf}{mf}
            """, [paths.synthetic_trips, paths.synthetic_persons]).fetchall()
            syn_rows = [(cid, mode, float(h)) for cid, mode, h in raw]

        return build_lineplot(
            microcensus_rows=mc_rows,
            synthetic_rows=syn_rows,
            group_key="mode",
            num_bins=num_bins,
            max_value=max_value,
            tick_fn="departure_time",
        )

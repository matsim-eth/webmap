import duckdb

from .base import DataProvider
from .helpers import (
    canton_filter_sql,
    parse_source_param,
    purpose_filter_sql,
)
from .lineplot_base import build_lineplot
from .paths import get_data_paths


class LineplotEuclideanDistancePurposeProvider(DataProvider):
    """Euclidean-distance lineplot grouped by trip purpose.

    Query params:
        canton   (str): Comma-separated canton names.
        source   (str): "Synthetic", "Microcensus", or omit for both.
        purpose  (str): Comma-separated purposes to include.
        num_bins (int): Number of bins (default 32).
        max_value(float): Upper bound in km (default auto from 95th pct).
    """

    ROUTE = "lineplot_euclidean_distance_data_purpose.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        num_bins = int(params.get("num_bins", 32))
        max_value_param = params.get("max_value")
        max_value = float(max_value_param) if max_value_param else None
        con = duckdb.connect()

        mc_rows = None
        syn_rows = None

        if "Microcensus" in sources:
            pf = purpose_filter_sql(params, "t.purpose")
            raw = con.execute(f"""
                SELECT p.canton_id, t.purpose,
                       t.crowfly_distance / 1000.0 AS dist_km
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.purpose IS NOT NULL
                  AND t.crowfly_distance IS NOT NULL
                {cf}{pf}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            mc_rows = [(cid, purpose, float(d)) for cid, purpose, d in raw]

        if "Synthetic" in sources:
            pf = purpose_filter_sql(params, "t.end_activity_type")
            raw = con.execute(f"""
                SELECT p.canton_id, t.end_activity_type,
                       t.euclidean_distance / 1000.0 AS dist_km
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p
                    ON TRY_CAST(t.person AS BIGINT) = p.person_id
                WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                  AND p.canton_id IS NOT NULL
                  AND t.end_activity_type IS NOT NULL
                  AND t.euclidean_distance IS NOT NULL
                {cf}{pf}
            """, [paths.synthetic_output_trips, paths.synthetic_persons]).fetchall()
            syn_rows = [(cid, purpose, float(d)) for cid, purpose, d in raw]

        return build_lineplot(
            microcensus_rows=mc_rows,
            synthetic_rows=syn_rows,
            group_key="purpose",
            num_bins=num_bins,
            max_value=max_value,
            tick_fn="distance",
        )

from .base import DataProvider, TRIP_FILTERS
from .connection import get_connection
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    age_filter_sql,
    parse_source_param,
    mode_filter_sql,
    share_rows_by_canton_source,
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
    PARAMS = TRIP_FILTERS

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        mf = mode_filter_sql(params, "t.mode")
        gf = gender_filter_sql(params, "p.sex")
        af = age_filter_sql(params, "p.age")
        con = get_connection()

        def grouped_rows():
            for source_label, trips_path, persons_path in [
                ("Synthetic", paths.synthetic_trips, paths.synthetic_persons),
                ("Microcensus", paths.microcensus_trips, paths.microcensus_persons),
            ]:
                if source_label not in sources:
                    continue
                rows = con.execute(f"""
                    SELECT p.canton_id, t.mode, COUNT(*) AS cnt
                    FROM read_parquet(?) t
                    INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL AND t.mode IS NOT NULL
                    {cf}{mf}{gf}{af}
                    GROUP BY p.canton_id, t.mode
                """, [trips_path, persons_path]).fetchall()
                for cid, mode, cnt in rows:
                    yield (source_label, cid, str(mode), cnt)

        return share_rows_by_canton_source(
            grouped_rows(),
            sources=sources,
            bin_field="mode",
            round_digits=8,
            max_share_field="max_share_per_mode",
        )

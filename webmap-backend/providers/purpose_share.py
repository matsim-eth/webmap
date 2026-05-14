from .base import DataProvider, CANTON, SOURCE, GENDER, MODE, PURPOSE
from .connection import get_connection
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    parse_source_param,
    mode_filter_sql,
    purpose_filter_sql,
    share_rows_by_canton_source,
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

        # Synthetic stores it as `preceding_purpose`; Microcensus as `purpose`.
        # Filter column has to match the source schema, so the purpose filter
        # SQL is rebuilt per source.
        source_specs = [
            ("Synthetic", paths.synthetic_trips, paths.synthetic_persons, "t.preceding_purpose"),
            ("Microcensus", paths.microcensus_trips, paths.microcensus_persons, "t.purpose"),
        ]

        def grouped_rows():
            for source_label, trips_path, persons_path, purpose_col in source_specs:
                if source_label not in sources:
                    continue
                pf = purpose_filter_sql(params, purpose_col)
                rows = con.execute(f"""
                    SELECT p.canton_id, {purpose_col} AS purpose, COUNT(*) AS cnt
                    FROM read_parquet(?) t
                    INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                    WHERE p.canton_id IS NOT NULL AND {purpose_col} IS NOT NULL
                    {cf}{pf}{mf}{gf}
                    GROUP BY p.canton_id, {purpose_col}
                """, [trips_path, persons_path]).fetchall()
                for cid, purpose, cnt in rows:
                    yield (source_label, cid, str(purpose), cnt)

        return share_rows_by_canton_source(
            grouped_rows(),
            sources=sources,
            bin_field="purpose",
            round_digits=8,
            max_share_field="max_share_per_purpose",
        )

from .base import DataProvider, CANTON, SOURCE, GENDER
from .connection import get_connection
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    parse_source_param,
    share_by_canton_source,
)
from .paths import get_data_paths


class CarAvailabilityProvider(DataProvider):
    """Car availability distribution per canton and source.

    Query params:
        canton  (str): Comma-separated canton names to include.
        source  (str): "Synthetic", "Microcensus", or omit for both.
        gender  (str): "0" or "1" to filter by sex.

    Example: /data/car_availability.json?canton=Zurich,Bern&source=Synthetic&gender=1
    """

    ROUTE = "car_availability.json"
    PARAMS = [CANTON, SOURCE, GENDER]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = gender_filter_sql(params, "p.sex")
        con = get_connection()

        all_rows: list = []
        for source_label, path in [("Synthetic", paths.synthetic_persons),
                                   ("Microcensus", paths.microcensus_persons)]:
            if source_label not in sources:
                continue
            rows = con.execute(f"""
                SELECT p.canton_id, p.car_availability, COUNT(*) AS cnt
                FROM read_parquet(?) p
                WHERE p.canton_id IS NOT NULL AND p.car_availability IS NOT NULL
                {cf}{gf}
                GROUP BY p.canton_id, p.car_availability
            """, [path]).fetchall()
            for cid, val, cnt in rows:
                all_rows.append((source_label, cid, str(int(val)), cnt))

        # Numeric-sort the car classes (e.g. "0","1","2") so output ordering
        # matches the pre-refactor lexicographic-by-int behavior.
        car_classes = sorted({r[2] for r in all_rows}, key=lambda x: int(x))

        return share_by_canton_source(
            all_rows,
            sources=sources,
            bin_keys=car_classes,
            round_digits=16,
        )

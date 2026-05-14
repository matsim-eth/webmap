from .base import DataProvider, CANTON, SOURCE, AGE_MIN, AGE_MAX
from .connection import get_connection
from .helpers import (
    canton_filter_sql,
    age_filter_sql,
    parse_source_param,
    share_by_canton_source,
)
from .paths import get_data_paths


class GenderProvider(DataProvider):
    """Gender distribution per canton and source."""

    ROUTE = "gender.json"
    PARAMS = [CANTON, SOURCE, AGE_MIN, AGE_MAX]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        af = age_filter_sql(params)
        con = get_connection()

        def grouped_rows():
            for source_label, path in [("Synthetic", paths.synthetic_persons),
                                        ("Microcensus", paths.microcensus_persons)]:
                if source_label not in sources:
                    continue
                rows = con.execute(f"""
                    SELECT canton_id, CAST(sex AS INTEGER) AS gender, COUNT(*) AS cnt
                    FROM read_parquet(?)
                    WHERE canton_id IS NOT NULL AND sex IS NOT NULL
                      AND CAST(sex AS INTEGER) IN (0, 1)
                      {cf}{af}
                    GROUP BY canton_id, gender
                """, [path]).fetchall()
                for cid, g, cnt in rows:
                    yield (source_label, cid, str(int(g)), cnt)

        return share_by_canton_source(
            grouped_rows(),
            sources=sources,
            bin_keys=["0", "1"],
        )

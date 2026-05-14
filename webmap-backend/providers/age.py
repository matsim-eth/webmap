from .base import DataProvider, Param, CANTON, SOURCE, GENDER
from .constants import DEFAULT_AGE_BINS
from .connection import get_connection
from .helpers import (
    canton_filter_sql,
    gender_filter_sql,
    parse_source_param,
    share_by_canton_source,
)
from .paths import get_data_paths


def _parse_age_bins(params: dict) -> list[tuple[int, int, str]]:
    bounds_str = params.get("bounds")
    if not bounds_str:
        return DEFAULT_AGE_BINS
    try:
        vals = [int(x.strip()) for x in bounds_str.split(",")]
        if len(vals) < 2:
            return DEFAULT_AGE_BINS
        return [(vals[i], vals[i + 1], f"[{vals[i]}, {vals[i + 1]})") for i in range(len(vals) - 1)]
    except Exception:
        return DEFAULT_AGE_BINS


def _age_bin_sql(bins: list[tuple[int, int, str]], col: str = "age") -> str:
    """Build a SQL CASE expression for age binning."""
    cases = " ".join(
        f"WHEN {col} >= {lo} AND {col} < {hi} THEN '{label}'"
        for lo, hi, label in bins
    )
    return f"CASE {cases} END"


class AgeProvider(DataProvider):
    """Age distribution per canton and source."""

    ROUTE = "age.json"
    PARAMS = [CANTON, SOURCE, GENDER, Param("bounds", "Custom age bin boundaries (comma-separated)")]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        bins = _parse_age_bins(params)
        bins_order = [b[2] for b in bins]
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        gf = gender_filter_sql(params)
        con = get_connection()

        age_case = _age_bin_sql(bins)

        def grouped_rows():
            for source_label, path in [("Synthetic", paths.synthetic_persons),
                                        ("Microcensus", paths.microcensus_persons)]:
                if source_label not in sources:
                    continue
                rows = con.execute(f"""
                    SELECT canton_id, {age_case} AS age_bin, COUNT(*) AS cnt
                    FROM read_parquet(?)
                    WHERE canton_id IS NOT NULL AND age IS NOT NULL{cf}{gf}
                    GROUP BY canton_id, age_bin
                    HAVING age_bin IS NOT NULL
                """, [path]).fetchall()
                for cid, bin_label, cnt in rows:
                    yield (source_label, cid, bin_label, cnt)

        return share_by_canton_source(
            grouped_rows(),
            sources=sources,
            bin_keys=bins_order,
        )

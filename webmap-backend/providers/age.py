from collections import defaultdict

from .base import DataProvider, Param, CANTON, SOURCE, GENDER
from .constants import DEFAULT_AGE_BINS
from .connection import get_connection
from .helpers import canton_filter_sql, gender_filter_sql, parse_source_param, build_canton_lookup
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

        counts = defaultdict(int)
        seen_cantons = set()

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
                seen_cantons.add(int(cid))
                counts[(source_label, int(cid), str(bin_label))] += cnt

        # "All" canton aggregate
        all_canton = defaultdict(int)
        for (source, cid, bl), cnt in counts.items():
            all_canton[(source, "All", bl)] += cnt
        counts.update(all_canton)

        # Totals per (source, cid)
        totals = defaultdict(int)
        for (source, cid, bl), cnt in counts.items():
            totals[(source, cid)] += cnt

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for b in bins_order:
                    denom = float(totals.get((source, cid), 0))
                    num = float(counts.get((source, cid, b), 0))
                    share = (num / denom) if denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {})[b] = share

        return out

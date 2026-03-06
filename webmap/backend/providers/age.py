import duckdb

from .base import DataProvider
from .constants import DEFAULT_AGE_BINS
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


def _age_bin(age, bins: list[tuple[int, int, str]]) -> str | None:
    try:
        a = int(age)
    except Exception:
        return None
    for lo, hi, label in bins:
        if lo <= a < hi:
            return label
    return None


class AgeProvider(DataProvider):
    """Age distribution per canton and source.

    Query params:
        canton  (str): Comma-separated canton names.
        source  (str): "Synthetic", "Microcensus", or omit for both.
        gender  (str): "0" or "1" to filter by sex.
        bounds  (str): Custom age bin boundaries, e.g. "6,18,65,80".

    Example: /data/age.json?canton=Zurich&gender=0&bounds=0,18,30,65,100
    """

    ROUTE = "age.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        bins = _parse_age_bins(params)
        bins_order = [b[2] for b in bins]
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        gf = gender_filter_sql(params)
        con = duckdb.connect()

        def read_rows(path: str, label: str) -> list[tuple]:
            res = con.execute(
                f"SELECT age, canton_id FROM read_parquet(?) WHERE canton_id IS NOT NULL{cf}{gf}",
                [path],
            ).fetchall()
            rows = []
            for age, cid in res:
                b = _age_bin(age, bins)
                if b is None:
                    continue
                rows.append((label, int(cid), b))
            return rows

        rows: list[tuple] = []
        if "Synthetic" in sources:
            rows.extend(read_rows(paths.synthetic_persons, "Synthetic"))
        if "Microcensus" in sources:
            rows.extend(read_rows(paths.microcensus_persons, "Microcensus"))

        counts: dict = {}
        totals: dict = {}

        for source, cid, bin_label in rows:
            counts[(source, cid, bin_label)] = counts.get((source, cid, bin_label), 0) + 1
            totals[(source, cid)] = totals.get((source, cid), 0) + 1
            counts[(source, "All", bin_label)] = counts.get((source, "All", bin_label), 0) + 1
            totals[(source, "All")] = totals.get((source, "All"), 0) + 1

        seen_cantons = {cid for (_, cid, _) in rows if cid != "All"}
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

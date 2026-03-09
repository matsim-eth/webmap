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


class NumCarsAgeProvider(DataProvider):
    """Number-of-cars distribution broken down by age group.

    Query params:
        bounds  (str): Comma-separated age bin boundaries, e.g. "6,15,18,24,30,45,65,80".
        canton  (str): Comma-separated canton names.
        source  (str): "Synthetic", "Microcensus", or omit for both.
        gender  (str): "0" or "1" to filter by sex.

    Example: /data/num_cars_age.json?bounds=6,18,65,80&canton=Zurich
    """

    ROUTE = "num_cars_age.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        bins = _parse_age_bins(params)
        sources = parse_source_param(params)
        cf_p = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf_p = gender_filter_sql(params, "p.sex")
        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
        seen_cantons: set = set()

        def tally(source: str, cid: int, age, val) -> None:
            bin_label = _age_bin(age, bins)
            if bin_label is None:
                return
            seen_cantons.add(cid)
            cc = str(int(val))
            counts[(source, cid, bin_label, cc)]    = counts.get((source, cid, bin_label, cc), 0) + 1
            totals[(source, cid, bin_label)]         = totals.get((source, cid, bin_label), 0) + 1
            counts[(source, "All", bin_label, cc)]   = counts.get((source, "All", bin_label, cc), 0) + 1
            totals[(source, "All", bin_label)]       = totals.get((source, "All", bin_label), 0) + 1

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, p.age, h.number_of_cars_class
                FROM read_parquet(?) p
                INNER JOIN read_parquet(?) h ON p.household_id = h.household_id
                WHERE p.canton_id IS NOT NULL AND p.age IS NOT NULL AND h.number_of_cars_class IS NOT NULL
                {cf_p}{gf_p}
            """, [paths.synthetic_persons, paths.synthetic_households]).fetchall()
            for cid, age, val in rows:
                tally("Synthetic", int(cid), age, val)

        if "Microcensus" in sources:
            cf_mc = canton_filter_sql(params.get("canton"))
            gf_mc = gender_filter_sql(params)
            rows = con.execute(f"""
                SELECT canton_id, age, number_of_cars_class
                FROM read_parquet(?)
                WHERE canton_id IS NOT NULL AND age IS NOT NULL AND number_of_cars_class IS NOT NULL
                {cf_mc}{gf_mc}
            """, [paths.microcensus_persons]).fetchall()
            for cid, age, val in rows:
                tally("Microcensus", int(cid), age, val)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        car_classes = sorted({k for (_, _, _, k) in counts.keys()}, key=lambda x: int(x))
        bin_labels = [b[2] for b in bins]

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for bin_label in bin_labels:
                    denom = float(totals.get((source, cid, bin_label), 0))
                    for cc in car_classes:
                        num = float(counts.get((source, cid, bin_label, cc), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(bin_label, {})[cc] = share

        return out

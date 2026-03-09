import duckdb

from .base import DataProvider
from .constants import SUBS, SUB_LABELS, DEFAULT_AGE_BINS
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


class PtSubAgeProvider(DataProvider):
    """PT subscription rates broken down by age group.

    Query params:
        bounds  (str): Comma-separated age bin boundaries, e.g. "6,18,65,80".
        canton  (str): Comma-separated canton names.
        source  (str): "Synthetic", "Microcensus", or omit for both.
        gender  (str): "0" or "1" to filter by sex.

    Example: /data/pt_sub_age.json?bounds=6,18,65,80&canton=Zurich&gender=0
    """

    ROUTE = "pt_sub_age.json"

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        bins = _parse_age_bins(params)
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"))
        gf = gender_filter_sql(params)
        cols = ", ".join(f"subscriptions_{s}" for s in SUBS)
        con = duckdb.connect()

        def read_rows(path: str, label: str) -> list[tuple]:
            res = con.execute(
                f"SELECT canton_id, age, {cols} FROM read_parquet(?) WHERE canton_id IS NOT NULL AND age IS NOT NULL{cf}{gf}",
                [path],
            ).fetchall()
            rows = []
            for row in res:
                cid, age = row[0], row[1]
                sub_vals = row[2:]
                bin_label = _age_bin(age, bins)
                if bin_label is None:
                    continue
                rows.append((label, int(cid), bin_label, sub_vals))
            return rows

        rows: list[tuple] = []
        if "Synthetic" in sources:
            rows.extend(read_rows(paths.synthetic_persons, "Synthetic"))
        if "Microcensus" in sources:
            rows.extend(read_rows(paths.microcensus_persons, "Microcensus"))

        counts: dict = {s: {} for s in SUBS}
        totals: dict = {}
        seen_cantons: set = set()

        for source, cid, bin_label, sub_vals in rows:
            seen_cantons.add(cid)
            totals[(source, cid, bin_label)]    = totals.get((source, cid, bin_label), 0) + 1
            totals[(source, "All", bin_label)] = totals.get((source, "All", bin_label), 0) + 1
            for i, s in enumerate(SUBS):
                if sub_vals[i]:
                    counts[s][(source, cid, bin_label)]    = counts[s].get((source, cid, bin_label), 0) + 1
                    counts[s][(source, "All", bin_label)] = counts[s].get((source, "All", bin_label), 0) + 1

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        bin_labels = [b[2] for b in bins]

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                for bin_label in bin_labels:
                    denom = float(totals.get((source, cid, bin_label), 0))
                    for s in SUBS:
                        num = float(counts[s].get((source, cid, bin_label), 0))
                        share = round(num / denom, 6) if denom > 0 else 0.0
                        out.setdefault(cname, {}).setdefault(source, {}).setdefault(bin_label, {})[SUB_LABELS[s]] = share

        return out

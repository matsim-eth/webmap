import duckdb

from .base import DataProvider

from .helpers import canton_filter_sql, gender_filter_sql, parse_source_param, build_canton_lookup
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

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        gf = gender_filter_sql(params, "p.sex")
        con = duckdb.connect()

        counts: dict = {}
        totals: dict = {}
        seen_cantons: set = set()

        def tally(source: str, cid: int, val) -> None:
            seen_cantons.add(cid)
            key = str(int(val))
            counts[(source, cid, key)] = counts.get((source, cid, key), 0) + 1
            totals[(source, cid)]      = totals.get((source, cid), 0) + 1
            counts[(source, "All", key)] = counts.get((source, "All", key), 0) + 1
            totals[(source, "All")]      = totals.get((source, "All"), 0) + 1

        for source, path in [("Synthetic", paths.synthetic_persons),
                             ("Microcensus", paths.microcensus_persons)]:
            if source not in sources:
                continue
            rows = con.execute(f"""
                SELECT p.canton_id, p.car_availability
                FROM read_parquet(?) p
                WHERE p.canton_id IS NOT NULL AND p.car_availability IS NOT NULL
                {cf}{gf}
            """, [path]).fetchall()
            for cid, val in rows:
                tally(source, int(cid), val)

        canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
        car_classes = sorted({k for (_, _, k) in counts.keys()}, key=lambda x: int(x))

        out: dict = {}
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            for source in sources:
                denom = float(totals.get((source, cid), 0))
                for cc in car_classes:
                    num = float(counts.get((source, cid, cc), 0))
                    share = round(num / denom, 16) if denom > 0 else 0.0
                    out.setdefault(cname, {}).setdefault(source, {})[cc] = share

        return out
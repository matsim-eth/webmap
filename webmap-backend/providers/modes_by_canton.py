from .base import DataProvider, Param, CANTON, SOURCE
from .connection import get_connection
from .constants import canton_name, CANTON_MAP
from .helpers import canton_filter_sql, parse_source_param, build_canton_lookup
from .paths import get_data_paths


class ModesByCantonProvider(DataProvider):
    """Distinct transport modes available per canton across both data sources.

    Query params:
        canton        (str): Comma-separated canton names.
        source        (str): "Synthetic", "Microcensus", or omit for both.
        exclude_modes (str): Comma-separated modes to exclude from results.

    Example: /data/modes_by_canton.json?canton=Zurich,Bern&exclude_modes=walk,other
    """

    ROUTE = "modes_by_canton.json"
    PARAMS = [CANTON, SOURCE,
              Param("exclude_modes", "Comma-separated modes to exclude from results")]

    def deliver(self, params: dict) -> dict:
        paths = get_data_paths()
        sources = parse_source_param(params)
        cf = canton_filter_sql(params.get("canton"), "p.canton_id")
        con = get_connection()

        exclude = set()
        if params.get("exclude_modes"):
            exclude = {m.strip() for m in params["exclude_modes"].split(",")}

        # canton_id -> set of modes
        modes_by_canton: dict[int, set[str]] = {}

        if "Microcensus" in sources:
            rows = con.execute(f"""
                SELECT DISTINCT p.canton_id, t.mode_detailed
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p ON t.person_id = p.person_id
                WHERE p.canton_id IS NOT NULL
                  AND t.mode_detailed IS NOT NULL
                {cf}
            """, [paths.microcensus_trips, paths.microcensus_persons]).fetchall()
            for cid, mode in rows:
                cid = int(cid)
                mode = str(mode)
                modes_by_canton.setdefault(cid, set()).add(mode)

        if "Synthetic" in sources:
            rows = con.execute(f"""
                SELECT p.canton_id, t.modes
                FROM read_parquet(?) t
                INNER JOIN read_parquet(?) p
                    ON TRY_CAST(t.person AS BIGINT) = p.person_id
                WHERE TRY_CAST(t.person AS BIGINT) IS NOT NULL
                  AND p.canton_id IS NOT NULL
                  AND t.modes IS NOT NULL
                {cf}
            """, [paths.synthetic_output_trips, paths.synthetic_persons]).fetchall()
            for cid, modes_str in rows:
                cid = int(cid)
                sub_modes = str(modes_str).split("-")
                for m in sub_modes:
                    m = m.strip()
                    if m:
                        modes_by_canton.setdefault(cid, set()).add(m)

        result: dict = {}
        for cid, mode_set in sorted(modes_by_canton.items()):
            cname = canton_name(cid)
            filtered = sorted(mode_set - exclude)
            result[cname] = filtered

        return result

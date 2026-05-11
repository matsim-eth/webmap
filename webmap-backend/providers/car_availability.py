"""Car-availability distribution provider."""

from __future__ import annotations

from .base import DataProvider, CANTON, SOURCE, GENDER, Param
from .connection import get_source_cursor
from .helpers import (
    gender_filter_sql,
    get_hot_polygon_meta,
    parse_source_param,
)
from ._pre_agg import (
    build_share_response,
    label_for,
    make_label_resolver,
    polygon_filter_clause,
    resolve_polygon_ids,
    _source_label,
)


# Pre-aggregated columns. Bin labels match the legacy stringified integers
# ("0" = always have a car, "1" = sometimes, "2" = never) which is what
# the frontend already consumes.
COL_TO_BIN = {
    "car_avail_always":    "0",
    "car_avail_sometimes": "1",
    "car_avail_never":     "2",
}


def _raw_path(sources, polygon_ids, params):
    """Slow path used when a gender filter is active (the demo_grid does not
    cross-tab car_avail × sex)."""
    gf = gender_filter_sql(params, "p.sex")
    out = {}
    for source in sources:
        try:
            con = get_source_cursor(source)
        except Exception:
            continue
        if polygon_ids:
            pjoin, pwhere, group_expr, pbind, _ = polygon_filter_clause(polygon_ids)
            resolve = make_label_resolver(con, polygon_ids,
                                           all(p.startswith("canton:") for p in polygon_ids))
            sql = f"""
                SELECT {group_expr} AS poly_key, p.car_availability, COUNT(*) AS cnt
                FROM persons p
                {pjoin}
                WHERE p.car_availability IS NOT NULL{pwhere}{gf}
                GROUP BY poly_key, p.car_availability
            """
            rows = con.execute(sql, pbind).fetchall()
            per_pid: dict[str, dict[str, int]] = {}
            for poly_key, val, cnt in rows:
                label = resolve(poly_key)
                per_pid.setdefault(label, {})[_avail_to_bin(val)] = cnt
            for label, vals in per_pid.items():
                denom = sum(vals.values())
                if denom == 0:
                    continue
                entry = out.setdefault(label, {}).setdefault(_source_label(source), {})
                for k in ("0", "1", "2"):
                    v = vals.get(k, 0)
                    entry[k] = (v / denom) if denom > 0 else 0.0

        rows_all = con.execute(f"""
            SELECT p.car_availability, COUNT(*) FROM persons p
            WHERE p.car_availability IS NOT NULL{gf}
            GROUP BY p.car_availability
        """).fetchall()
        all_dict = {_avail_to_bin(v): c for v, c in rows_all}
        denom = sum(all_dict.values())
        if denom == 0:
            continue
        entry = out.setdefault("All", {}).setdefault(_source_label(source), {})
        for k in ("0", "1", "2"):
            entry[k] = (all_dict.get(k, 0) / denom) if denom > 0 else 0.0
    return out


def _avail_to_bin(value) -> str:
    """Map persons.car_availability VARCHAR to legacy integer bin label."""
    s = str(value).lower()
    if s in ("always", "0"):
        return "0"
    if s in ("sometimes", "1"):
        return "1"
    return "2"


class CarAvailabilityProvider(DataProvider):
    """Car availability distribution per polygon and source."""

    ROUTE = "car_availability.json"
    PARAMS = [
        CANTON, SOURCE, GENDER,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        if not (params.get("gender") or params.get("sex")):
            return build_share_response(
                sources=sources,
                polygon_ids=polygon_ids,
                column_to_bin=COL_TO_BIN,
                bin_order=["0", "1", "2"],
                round_digits=16,
            )
        return _raw_path(sources, polygon_ids, params)

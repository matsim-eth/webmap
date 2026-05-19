"""Mode-share per polygon.

Fast path: ``hot_polygon_trips`` (mode_car, mode_pt, …). Falls back to a
raw scan against ``trips`` JOIN ``persons`` when a person-level filter is
active (gender, age).
"""

from __future__ import annotations

from .base import DataProvider, TRIP_FILTERS, Param
from .connection import get_source_cursor
from .helpers import (
    age_filter_sql,
    gender_filter_sql,
    get_hot_polygon_meta,
    mode_filter_sql,
    parse_source_param,
    has_person_filters,
)
from ._pre_agg import label_for, resolve_polygon_ids, _select_hot_row, _sum_grid, _source_label


MODE_COL = {
    "car":           "mode_car",
    "pt":            "mode_pt",
    "walk":          "mode_walk",
    "bike":          "mode_bike",
    "car_passenger": "mode_car_passenger",
}


class ModeShareProvider(DataProvider):
    ROUTE = "mode_share.json"
    PARAMS = TRIP_FILTERS + [
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        # Filter modes if requested
        mode_filter = None
        m = params.get("mode")
        if m:
            mode_filter = {x.strip() for x in m.split(",")}

        # Fast path
        if not has_person_filters(params):
            return self._fast(sources, polygon_ids, mode_filter)
        return self._raw(sources, polygon_ids, params, mode_filter)

    def _fast(self, sources, polygon_ids, mode_filter):
        out: dict = {"max_share_per_mode": {}}
        max_share: dict[str, float] = {}
        modes_in_use = (
            [m for m in MODE_COL if not mode_filter or m in mode_filter]
            or list(MODE_COL.keys())
        )
        cols = [MODE_COL[m] for m in modes_in_use]
        is_custom = (len(polygon_ids) == 1 and polygon_ids[0].startswith("custom:"))

        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            slabel = _source_label(source)
            entries: list[dict] = []

            if is_custom:
                geojson_str = polygon_ids[0].split(":", 1)[1].replace("'", "''")
                cols_sql = ", ".join(f"COALESCE(SUM({c}),0)" for c in cols)
                row = con.execute(f"""
                    WITH custom_poly AS (
                        SELECT ST_Transform(ST_GeomFromGeoJSON('{geojson_str}'),
                                            'EPSG:4326', 'EPSG:2056', always_xy := true) AS geom
                    )
                    SELECT {cols_sql} FROM trip_grid_origin_500m g, custom_poly
                    WHERE ST_Intersects(g.cell_geom, custom_poly.geom)
                """).fetchone()
                vals = dict(zip(cols, row))
                denom = sum(int(v or 0) for v in vals.values())
                if denom == 0:
                    # source has no data for this polygon — skip it entirely
                    continue
                for m in modes_in_use:
                    num = float(vals.get(MODE_COL[m], 0) or 0)
                    share = round(num / denom, 8) if denom > 0 else 0.0
                    entries.append({"canton_name": "Custom", "mode": m, "share": share})
                    max_share[m] = max(max_share.get(m, 0.0), share)
            else:
                rows = _select_hot_row(con, "hot_polygon_trips", polygon_ids, cols)
                meta = get_hot_polygon_meta(con, list(rows.keys()))
                for pid, vals in rows.items():
                    denom = sum(int(v or 0) for v in vals.values())
                    label = label_for(pid, meta)
                    for m in modes_in_use:
                        num = float(vals.get(MODE_COL[m], 0) or 0)
                        share = round(num / denom, 8) if denom > 0 else 0.0
                        entries.append({"canton_name": label, "mode": m, "share": share})
                        if label != "All":
                            max_share[m] = max(max_share.get(m, 0.0), share)

            sums = _sum_grid(con, "trip_grid_origin_500m", cols)
            denom = sum(int(v or 0) for v in sums.values())
            if denom == 0:
                # Source has no data — drop it entirely instead of emitting
                # zero-shares for "All".
                continue
            for m in modes_in_use:
                num = float(sums.get(MODE_COL[m], 0) or 0)
                share = round(num / denom, 8) if denom > 0 else 0.0
                entries.append({"canton_name": "All", "mode": m, "share": share})

            out[slabel] = entries
        out["max_share_per_mode"] = max_share
        return out

    def _raw(self, sources, polygon_ids, params, mode_filter):
        gf = gender_filter_sql(params, "p.sex")
        af = age_filter_sql(params, "p.age")
        mf = mode_filter_sql(params, "t.main_mode")
        out: dict = {"max_share_per_mode": {}}
        max_share: dict[str, float] = {}

        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            slabel = _source_label(source)
            entries: list[dict] = []

            if polygon_ids:
                placeholders = ",".join(["?"] * len(polygon_ids))
                rows = con.execute(f"""
                    SELECT hp.polygon_id, t.main_mode, COUNT(*) AS cnt
                    FROM trips t
                    JOIN persons p ON p.person_id = t.person_id
                    JOIN hot_polygons hp ON hp.polygon_id IN ({placeholders})
                       AND ST_Within(p.home_pt, hp.polygon_geom)
                    WHERE t.main_mode IS NOT NULL{gf}{af}{mf}
                    GROUP BY hp.polygon_id, t.main_mode
                """, polygon_ids).fetchall()
                meta = get_hot_polygon_meta(con, polygon_ids)
                per_label: dict[str, dict[str, int]] = {}
                for pid, mode, cnt in rows:
                    if mode_filter and mode not in mode_filter:
                        continue
                    label = label_for(pid, meta)
                    per_label.setdefault(label, {})[mode] = cnt
                for label, vals in per_label.items():
                    denom = sum(vals.values())
                    for m, cnt in vals.items():
                        share = round(cnt / denom, 8) if denom > 0 else 0.0
                        entries.append({"canton_name": label, "mode": m, "share": share})
                        max_share[m] = max(max_share.get(m, 0.0), share)

            rows_all = con.execute(f"""
                SELECT t.main_mode, COUNT(*) FROM trips t
                JOIN persons p ON p.person_id = t.person_id
                WHERE t.main_mode IS NOT NULL{gf}{af}{mf}
                GROUP BY t.main_mode
            """).fetchall()
            all_dict = {m: c for m, c in rows_all if not (mode_filter and m not in mode_filter)}
            denom = sum(all_dict.values())
            for m, cnt in all_dict.items():
                share = round(cnt / denom, 8) if denom > 0 else 0.0
                entries.append({"canton_name": "All", "mode": m, "share": share})

            out[slabel] = entries
        out["max_share_per_mode"] = max_share
        return out

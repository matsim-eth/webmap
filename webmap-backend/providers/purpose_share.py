"""Purpose-share per polygon.

Fast path: ``hot_polygon_trips`` (purpose_home, purpose_work, …).
Falls back to a raw scan against ``trips`` JOIN ``persons`` when a
person-level filter is active.
"""

from __future__ import annotations

from .base import DataProvider, CANTON, SOURCE, GENDER, MODE, PURPOSE, Param
from .connection import get_source_cursor
from .helpers import (
    age_filter_sql,
    gender_filter_sql,
    get_hot_polygon_meta,
    has_person_filters,
    mode_filter_sql,
    parse_source_param,
    purpose_filter_sql,
)
from ._pre_agg import (
    label_for,
    resolve_polygon_ids,
    _select_hot_row,
    _sum_grid,
    _source_label,
)


PURPOSE_COL = {
    "home":      "purpose_home",
    "work":      "purpose_work",
    "education": "purpose_education",
    "shop":      "purpose_shop",
    "leisure":   "purpose_leisure",
    "other":     "purpose_other",
}


class PurposeShareProvider(DataProvider):
    ROUTE = "purpose_share.json"
    PARAMS = [
        CANTON, SOURCE, GENDER, MODE, PURPOSE,
        Param("polygon_id", "Hot-polygon ID(s), comma-separated"),
    ]

    def deliver(self, params: dict) -> dict:
        sources = parse_source_param(params)
        if not sources:
            return {}
        con0 = get_source_cursor(sources[0])
        polygon_ids = resolve_polygon_ids(con0, params, default_type="canton")

        purpose_filter = None
        p = params.get("purpose")
        if p:
            purpose_filter = {x.strip() for x in p.split(",")}

        if not has_person_filters(params) and not params.get("mode"):
            return self._fast(sources, polygon_ids, purpose_filter)
        return self._raw(sources, polygon_ids, params, purpose_filter)

    def _fast(self, sources, polygon_ids, purpose_filter):
        out: dict = {"max_share_per_purpose": {}}
        max_share: dict[str, float] = {}
        purposes = [p for p in PURPOSE_COL if not purpose_filter or p in purpose_filter] or list(PURPOSE_COL.keys())
        cols = [PURPOSE_COL[p] for p in purposes]
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
                    continue
                for p in purposes:
                    num = float(vals.get(PURPOSE_COL[p], 0) or 0)
                    share = round(num / denom, 8) if denom > 0 else 0.0
                    entries.append({"canton_name": "Custom", "purpose": p, "share": share})
                    max_share[p] = max(max_share.get(p, 0.0), share)
            else:
                rows = _select_hot_row(con, "hot_polygon_trips", polygon_ids, cols)
                meta = get_hot_polygon_meta(con, list(rows.keys()))
                for pid, vals in rows.items():
                    denom = sum(int(v or 0) for v in vals.values())
                    label = label_for(pid, meta)
                    for p in purposes:
                        num = float(vals.get(PURPOSE_COL[p], 0) or 0)
                        share = round(num / denom, 8) if denom > 0 else 0.0
                        entries.append({"canton_name": label, "purpose": p, "share": share})
                        if label != "All":
                            max_share[p] = max(max_share.get(p, 0.0), share)

            sums = _sum_grid(con, "trip_grid_origin_500m", cols)
            denom = sum(int(v or 0) for v in sums.values())
            if denom == 0:
                continue
            for p in purposes:
                num = float(sums.get(PURPOSE_COL[p], 0) or 0)
                share = round(num / denom, 8) if denom > 0 else 0.0
                entries.append({"canton_name": "All", "purpose": p, "share": share})

            out[slabel] = entries
        out["max_share_per_purpose"] = max_share
        return out

    def _raw(self, sources, polygon_ids, params, purpose_filter):
        gf = gender_filter_sql(params, "p.sex")
        af = age_filter_sql(params, "p.age")
        mf = mode_filter_sql(params, "t.main_mode")
        pf = purpose_filter_sql(params, "t.following_purpose")
        out: dict = {"max_share_per_purpose": {}}
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
                    SELECT hp.polygon_id, t.following_purpose AS purpose, COUNT(*) AS cnt
                    FROM trips t
                    JOIN persons p ON p.person_id = t.person_id
                    JOIN hot_polygons hp ON hp.polygon_id IN ({placeholders})
                       AND ST_Within(p.home_pt, hp.polygon_geom)
                    WHERE t.following_purpose IS NOT NULL{gf}{af}{mf}{pf}
                    GROUP BY hp.polygon_id, t.following_purpose
                """, polygon_ids).fetchall()
                meta = get_hot_polygon_meta(con, polygon_ids)
                per_label: dict[str, dict[str, int]] = {}
                for pid, purpose, cnt in rows:
                    if purpose_filter and purpose not in purpose_filter:
                        continue
                    label = label_for(pid, meta)
                    per_label.setdefault(label, {})[purpose] = cnt
                for label, vals in per_label.items():
                    denom = sum(vals.values())
                    for k, v in vals.items():
                        share = round(v / denom, 8) if denom > 0 else 0.0
                        entries.append({"canton_name": label, "purpose": k, "share": share})
                        max_share[k] = max(max_share.get(k, 0.0), share)

            rows_all = con.execute(f"""
                SELECT t.following_purpose AS purpose, COUNT(*) FROM trips t
                JOIN persons p ON p.person_id = t.person_id
                WHERE t.following_purpose IS NOT NULL{gf}{af}{mf}{pf}
                GROUP BY purpose
            """).fetchall()
            all_dict = {p: c for p, c in rows_all if not (purpose_filter and p not in purpose_filter)}
            denom = sum(all_dict.values())
            for k, v in all_dict.items():
                share = round(v / denom, 8) if denom > 0 else 0.0
                entries.append({"canton_name": "All", "purpose": k, "share": share})
            out[slabel] = entries
        out["max_share_per_purpose"] = max_share
        return out

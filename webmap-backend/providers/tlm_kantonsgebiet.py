"""TLM Kantonsgebiet data — served from the ``hot_polygons`` table.

Returns the same GeoJSON shape the legacy provider produced: a
FeatureCollection with one Feature per canton, properties
``{KANTONSNUMMER, NAME}``. Filters: ``canton`` (IDs), ``canton_name``,
``simplify`` (drop geometry).
"""

from __future__ import annotations

import json

from .base import DataProvider, Param
from .connection import default_source, get_source_cursor
from .constants import CANTON_MAP


class TlmKantonsgebietProvider(DataProvider):
    ROUTE = "tlm_kantonsgebiet.json"
    PARAMS = [
        Param("format", "Output format", enum=["geojson", "json"]),
        Param("canton", "Comma-separated canton IDs (KANTONSNUMMER)"),
        Param("canton_name", "Comma-separated canton names"),
        Param("simplify", "Remove geometry for lighter payload", enum=["true", "false"]),
    ]

    def deliver(self, params: dict) -> dict:
        fmt = (params.get("format") or "geojson").lower()
        if fmt not in ("geojson", "json"):
            fmt = "geojson"
        simplify = (params.get("simplify") or "").lower() == "true"

        canton_ids = None
        if params.get("canton"):
            try:
                canton_ids = {int(c.strip()) for c in params["canton"].split(",")}
            except ValueError:
                canton_ids = None
        canton_names = None
        if params.get("canton_name"):
            canton_names = {c.strip() for c in params["canton_name"].split(",")}

        src = default_source()
        if not src:
            return {"type": "FeatureCollection", "features": []}
        try:
            con = get_source_cursor(src)
        except Exception:
            return {"type": "FeatureCollection", "features": []}

        rows = con.execute("""
            SELECT polygon_id, polygon_name, ST_AsGeoJSON(polygon_geom)
            FROM hot_polygons
            WHERE polygon_type = 'canton'
            ORDER BY polygon_id
        """).fetchall()

        features = []
        for pid, name, geom_json in rows:
            try:
                cid = int(pid.split(":", 1)[1])
            except (ValueError, IndexError):
                continue
            if canton_ids is not None and cid not in canton_ids:
                continue
            if canton_names is not None and name not in canton_names:
                continue
            props = {"KANTONSNUMMER": cid, "NAME": name}
            feat: dict = {"type": "Feature", "properties": props}
            if not simplify and geom_json:
                try:
                    feat["geometry"] = json.loads(geom_json) if isinstance(geom_json, str) else geom_json
                except Exception:
                    pass
            features.append(feat)
        return {"type": "FeatureCollection", "features": features}

"""TLM Kantonsgebiet data — a thin legacy alias of ``zones.json``.

Served from the ``hot_polygons`` table, this returns the same GeoJSON shape
the legacy provider produced: a FeatureCollection with one Feature per
primary zone, properties ``{KANTONSNUMMER, NAME}`` (legacy prop names kept as
the frontend contract even for non-canton study areas). The zone set is the
dataset's primary zone type (``canton`` for legacy Swiss data). New callers
should prefer :class:`~.study_area.ZonesProvider` (``zones.json``); this route
survives so existing choropleth joins / bookmarks keep working.

Filters: ``canton``/``zone`` (IDs), ``canton_name``/``zone_name``,
``simplify`` (drop geometry).
"""

from __future__ import annotations

import json

from .base import DataProvider, Param
from .connection import default_source, get_source_cursor
from .zone_registry import get_registry


class TlmKantonsgebietProvider(DataProvider):
    ROUTE = "tlm_kantonsgebiet.json"
    PARAMS = [
        Param("format", "Output format", enum=["geojson", "json"]),
        Param("canton", "Comma-separated zone IDs (KANTONSNUMMER)"),
        Param("canton_name", "Comma-separated zone names"),
        Param("zone", "Comma-separated zone IDs (alias of canton)"),
        Param("zone_name", "Comma-separated zone names (alias of canton_name)"),
        Param("simplify", "Remove geometry for lighter payload", enum=["true", "false"]),
    ]

    def deliver(self, params: dict) -> dict:
        fmt = (params.get("format") or "geojson").lower()
        if fmt not in ("geojson", "json"):
            fmt = "geojson"
        simplify = (params.get("simplify") or "").lower() == "true"

        canton_ids = None
        id_param = params.get("canton") or params.get("zone")
        if id_param:
            try:
                canton_ids = {int(c.strip()) for c in id_param.split(",")}
            except ValueError:
                canton_ids = None
        canton_names = None
        name_param = params.get("canton_name") or params.get("zone_name")
        if name_param:
            canton_names = {c.strip() for c in name_param.split(",")}

        src = default_source()
        if not src:
            return {"type": "FeatureCollection", "features": []}
        try:
            con = get_source_cursor(src)
        except Exception:
            return {"type": "FeatureCollection", "features": []}

        ptype = get_registry().primary_type
        rows = con.execute("""
            SELECT polygon_id, polygon_name, ST_AsGeoJSON(polygon_geom)
            FROM hot_polygons
            WHERE polygon_type = ?
            ORDER BY polygon_id
        """, [ptype]).fetchall()

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

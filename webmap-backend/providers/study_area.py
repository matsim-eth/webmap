"""Study-area metadata + primary-zone geometry providers.

Two endpoints, both driven entirely by the per-dataset
:class:`~.zone_registry.ZoneRegistry` (which synthesizes Swiss defaults for
legacy datasets, so these serve sensible data for every dataset):

* ``study_area.json`` — the study-area metadata object (name/crs/bbox/center/
  zoom, primary zone type + labels, and the list of primary zones with
  per-zone WGS84 bboxes). Frontends fetch this once per dataset to init the
  map and the zone selector.
* ``zones.json`` — the primary-zone FeatureCollection (geometry reprojected
  ``registry.crs`` → EPSG:4326), with legacy ``KANTONSNUMMER``/``NAME`` props
  kept alongside the generic ``zone_id``/``name``/``display_name`` so existing
  choropleth joins keep working. ``?meta=true`` returns the same object as
  ``study_area.json``; ``?simplify=true`` drops geometry.

Errors degrade to ``{"error": ...}`` / empty collections — never raise.
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict

from fastapi.responses import JSONResponse, Response

from .base import DataProvider, Param
from .connection import default_source, get_source_cursor
from .paths import dataset_key
from .zone_registry import get_registry


# ─── Caches (keyed by dataset_key) ─────────────────────────────────────────
# The metadata dict is small; the zones FeatureCollection can be several MB.
_meta_cache: "OrderedDict[str, dict]" = OrderedDict()
_meta_lock = threading.Lock()
_META_MAX = 16

_zones_cache: "OrderedDict[tuple, bytes]" = OrderedDict()
_zones_lock = threading.Lock()
_ZONES_MAX = 4


# ─── Builders ──────────────────────────────────────────────────────────────

def _zone_bboxes(reg) -> dict[int, tuple[list | None, list | None]]:
    """Return ``{zone_id: (bbox, center)}`` for every primary zone, both in
    WGS84 — bbox as [minLon, minLat, maxLon, maxLat], center as an
    inside-the-polygon point (drives e.g. the destination-zones arcs).
    On any failure the dict is empty / entries are None."""
    out: dict[int, tuple[list | None, list | None]] = {}
    try:
        src = default_source()
        if not src:
            return out
        cur = get_source_cursor(src)
        # ST_PointOnSurface guarantees the point lies inside the polygon
        # (a concave zone's centroid may fall outside); fall back to
        # ST_Centroid if the function isn't available.
        rows = None
        for point_fn in ("ST_PointOnSurface", "ST_Centroid"):
            try:
                rows = cur.execute(
                    f"""
                    SELECT polygon_id,
                           ST_XMin(g), ST_YMin(g), ST_XMax(g), ST_YMax(g),
                           ST_X(c), ST_Y(c)
                    FROM (SELECT polygon_id,
                                 ST_Transform(polygon_geom, '{reg.crs}', 'EPSG:4326',
                                              always_xy := true) AS g,
                                 ST_Transform({point_fn}(polygon_geom), '{reg.crs}',
                                              'EPSG:4326', always_xy := true) AS c
                          FROM hot_polygons WHERE polygon_type = ?)
                    """,
                    [reg.primary_type],
                ).fetchall()
                break
            except Exception:
                continue
        if rows is None:
            return {}
    except Exception:
        return {}
    for pid, xmin, ymin, xmax, ymax, cx, cy in rows:
        try:
            zid = int(str(pid).split(":", 1)[1])
        except (ValueError, IndexError):
            continue
        bbox = None if None in (xmin, ymin, xmax, ymax) else [xmin, ymin, xmax, ymax]
        center = None if None in (cx, cy) else [round(cx, 6), round(cy, 6)]
        out[zid] = (bbox, center)
    return out


def _build_meta_dict() -> dict:
    """Assemble the study-area metadata object for the current dataset."""
    reg = get_registry()
    meta = reg.meta
    singular, plural = reg.zone_type_labels()
    bboxes = _zone_bboxes(reg)
    zones = [
        {
            # Canonical label (reg.zone_name), NOT the raw hot_polygons name:
            # provider responses label zones through zone_name (ASCII
            # CANTON_MAP spellings for Swiss cantons), and the frontends key
            # bbox/alias joins on that spelling. display_name carries the
            # pretty (accented) form.
            "id": zid,
            "name": reg.zone_name(zid),
            "display_name": reg.zone_display_name(zid),
            "bbox": bboxes.get(zid, (None, None))[0],
            # Inside-the-polygon point — arc endpoints (destination zones) etc.
            "center": bboxes.get(zid, (None, None))[1],
        }
        for zid, _name in reg.zones_sorted()
    ]
    return {
        "schema_version": meta.get("schema_version"),
        "name": meta.get("name"),
        "crs": reg.crs,
        "primary_zone_type": reg.primary_type,
        "zone_label": singular,
        "zone_label_plural": plural,
        "zone_types": meta.get("zone_types") or [],
        "bbox": meta.get("bbox"),
        "center": meta.get("center"),
        "zoom": meta.get("zoom"),
        "zones": zones,
    }


def study_area_dict() -> dict:
    """Cached study-area metadata dict for the current dataset."""
    dk = dataset_key()
    with _meta_lock:
        hit = _meta_cache.get(dk)
        if hit is not None:
            _meta_cache.move_to_end(dk)
            return hit
    built = _build_meta_dict()  # DB work outside the lock
    with _meta_lock:
        _meta_cache[dk] = built
        _meta_cache.move_to_end(dk)
        while len(_meta_cache) > _META_MAX:
            _meta_cache.popitem(last=False)
    return built


# Geometry budget: hot_polygons ships full-resolution national-survey
# boundaries — tens of MB as raw GeoJSON for a few hundred zones. The map
# only needs ~10 m fidelity, so simplify in the native (projected, metres)
# CRS before reprojecting, and round coordinates to 6 decimals (~0.1 m).
_SIMPLIFY_TOLERANCE_M = 10.0
_COORD_DECIMALS = 6


def _round_coords(obj):
    """Round nested GeoJSON coordinate arrays in place."""
    if isinstance(obj, list):
        if obj and isinstance(obj[0], (int, float)):
            return [round(v, _COORD_DECIMALS) for v in obj]
        return [_round_coords(v) for v in obj]
    return obj


def _build_zones_fc(simplify: bool) -> dict:
    """Build the primary-zone FeatureCollection (geometry → WGS84)."""
    reg = get_registry()
    src = default_source()
    if not src:
        return {"type": "FeatureCollection", "features": []}
    rows = None
    # ST_SimplifyPreserveTopology keeps shared borders from opening visible
    # gaps at this tolerance; fall back to the full geometry if unavailable.
    for geom_expr in (
        f"ST_SimplifyPreserveTopology(polygon_geom, {_SIMPLIFY_TOLERANCE_M})",
        "polygon_geom",
    ):
        try:
            cur = get_source_cursor(src)
            rows = cur.execute(
                f"""
                SELECT polygon_id, polygon_name,
                       ST_AsGeoJSON(ST_Transform({geom_expr}, '{reg.crs}',
                                                 'EPSG:4326', always_xy := true))
                FROM hot_polygons
                WHERE polygon_type = ?
                ORDER BY polygon_id
                """,
                [reg.primary_type],
            ).fetchall()
            break
        except Exception:
            continue
    if rows is None:
        return {"type": "FeatureCollection", "features": []}

    features = []
    for pid, name, geom_json in rows:
        try:
            zid = int(str(pid).split(":", 1)[1])
        except (ValueError, IndexError):
            continue
        # Canonical label via reg.zone_name (matches the labels every provider
        # response uses — ASCII CANTON_MAP spellings for Swiss cantons), so the
        # frontends' NAME-keyed bbox/alias/choropleth joins line up. The raw
        # hot_polygons spelling survives in display_name where it's prettier.
        label = reg.zone_name(zid)
        props = {
            "zone_id": zid,
            "name": label,
            "display_name": reg.zone_display_name(zid),
            # Legacy props kept so existing choropleth joins keep working.
            "KANTONSNUMMER": zid,
            "NAME": label,
        }
        feat: dict = {"type": "Feature", "properties": props}
        if not simplify and geom_json:
            try:
                geom = json.loads(geom_json) if isinstance(geom_json, str) else geom_json
                if isinstance(geom, dict) and "coordinates" in geom:
                    geom["coordinates"] = _round_coords(geom["coordinates"])
                feat["geometry"] = geom
            except Exception:
                pass
        features.append(feat)
    return {"type": "FeatureCollection", "features": features}


def zones_fc_bytes(simplify: bool) -> bytes:
    """Cached, pre-serialized primary-zone FeatureCollection for the current
    dataset. Serializing once per dataset (instead of per request) matters —
    the payload is MBs of geometry."""
    key = (dataset_key(), simplify)
    with _zones_lock:
        hit = _zones_cache.get(key)
        if hit is not None:
            _zones_cache.move_to_end(key)
            return hit
    built = json.dumps(
        _build_zones_fc(simplify), separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")  # DB work + serialization outside the lock
    with _zones_lock:
        _zones_cache[key] = built
        _zones_cache.move_to_end(key)
        while len(_zones_cache) > _ZONES_MAX:
            _zones_cache.popitem(last=False)
    return built


# ─── Providers ─────────────────────────────────────────────────────────────

class StudyAreaProvider(DataProvider):
    """Return the dataset's study-area metadata object.

    Example: /data/{dataset_id}/study_area.json
    """

    ROUTE = "study_area.json"
    PARAMS: list[Param] = []

    def deliver(self, params: dict) -> dict:
        try:
            return study_area_dict()
        except Exception as exc:
            return {"error": f"study area unavailable: {exc}"}


class ZonesProvider(DataProvider):
    """Return the primary-zone FeatureCollection (WGS84), or the study-area
    metadata object with ``?meta=true``.

    Example: /data/{dataset_id}/zones.json
             /data/{dataset_id}/zones.json?meta=true
             /data/{dataset_id}/zones.json?simplify=true
    """

    ROUTE = "zones.json"
    PARAMS = [
        Param("meta", "Return the study-area metadata object instead of geometry",
              enum=["true", "false"]),
        Param("simplify", "Remove geometry for a lighter payload",
              enum=["true", "false"]),
    ]

    def deliver(self, params: dict):
        try:
            if (params.get("meta") or "").lower() == "true":
                return JSONResponse(study_area_dict())
            simplify = (params.get("simplify") or "").lower() == "true"
            return Response(content=zones_fc_bytes(simplify),
                            media_type="application/geo+json")
        except Exception as exc:
            return {"error": f"zones unavailable: {exc}"}

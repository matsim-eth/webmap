"""Per-canton network geometry, built on demand from the ``network_links`` table.

The v2 duckdb also ships a precomputed ``merged_segments:{cid}`` static_asset,
but that blob is *thin* — only ``link_id``/``road_type``/``freespeed``. The road
"Volumes" and "MATSim Network" modules need ``modes`` (the car-only mode filter)
and ``capacity`` (line-width + the major-roads toggle); without them the Volumes
car filter matches nothing and the map renders blank.

``network_links`` already has ``modes``/``capacity``/``length`` plus the LV95
geometry, so we rebuild the same one-feature-per-directed-link FeatureCollection
the frontend expects (``mergeSegmentsByGeometry`` then merges forward+reverse by
shared geometry and carries these scalars onto each segment). Geometry is
reprojected LV95 (EPSG:2056) → WGS84 and coordinates are rounded to ~0.1 m to
keep the payload reasonable. Cached per (dataset, canton).
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict

from .connection import get_source_cursor
from .paths import dataset_key

# Serialized GeoJSON bytes per (dataset, canton). Each canton is large
# (Zurich ~178k links → tens of MB), so this is a small bounded LRU.
_CACHE: "OrderedDict[tuple, bytes]" = OrderedDict()
_CACHE_MAX = 6
_LOCK = threading.Lock()

_COORD_DECIMALS = 6  # ~0.1 m — plenty for the map; keeps the payload small


def _round_coords(geom: dict) -> dict:
    """Round LineString/MultiLineString coordinates in place to _COORD_DECIMALS.

    Rounding is deterministic, so a link and its reversed-coordinate twin still
    round to identical values — the frontend's geometry-key pairing of
    forward+reverse links is preserved.
    """
    t = geom.get("type")
    c = geom.get("coordinates")
    if not c:
        return geom
    if t == "LineString":
        geom["coordinates"] = [[round(x, _COORD_DECIMALS), round(y, _COORD_DECIMALS)] for x, y in c]
    elif t == "MultiLineString":
        geom["coordinates"] = [
            [[round(x, _COORD_DECIMALS), round(y, _COORD_DECIMALS)] for x, y in line]
            for line in c
        ]
    return geom


def merged_segments_geojson(canton_id: int) -> bytes | None:
    """Return the canton's network as serialized GeoJSON bytes, or None if the
    ``network_links`` table is unavailable (older datasets → caller falls back
    to the thin static_asset blob)."""
    ckey = (dataset_key(), canton_id)
    with _LOCK:
        hit = _CACHE.get(ckey)
        if hit is not None:
            _CACHE.move_to_end(ckey)
            return hit

    try:
        cur = get_source_cursor("synthetic")
        rows = cur.execute(
            """
            -- Some PT links carry freespeed = Infinity (and other columns could
            -- in principle be NaN/Inf too). json.dumps would emit the literal
            -- `Infinity`/`NaN` tokens, which are invalid JSON and make the
            -- frontend's res.json() throw ("unexpected character") — the loader
            -- then silently falls back to the GitHub CDN. Coerce non-finite
            -- values to NULL so the payload is always valid JSON.
            SELECT link_id, modes,
                   CASE WHEN isfinite(capacity)  THEN ROUND(capacity, 1)  END AS capacity,
                   -- m/s → km/h, matching the speed module's freespeed_kmh. The
                   -- Network color ramp (0..150) and the Segment/feature tables
                   -- all label and expect km/h; network_links stores m/s.
                   CASE WHEN isfinite(freespeed) THEN ROUND(freespeed * 3.6, 2) END AS freespeed,
                   CASE WHEN isfinite(length)    THEN ROUND(length, 2)    END AS length,
                   CASE WHEN isfinite(permlanes) THEN permlanes            END AS permlanes,
                   road_type,
                   ST_AsGeoJSON(
                       ST_Transform(geom, 'EPSG:2056', 'EPSG:4326', always_xy := true)
                   ) AS gj
            FROM network_links
            WHERE canton_id = ?
            """,
            [canton_id],
        ).fetchall()
    except Exception:
        return None  # table absent / incompatible dataset → fall back to blob
    if not rows:
        return None

    features = []
    for link_id, modes, capacity, freespeed, length, permlanes, road_type, gj in rows:
        if not gj:
            continue
        features.append({
            "type": "Feature",
            "properties": {
                "link_id": link_id,
                "modes": modes,
                "capacity": capacity,
                "freespeed": freespeed,
                "length": length,
                "permlanes": permlanes,
                "road_type": road_type,
            },
            "geometry": _round_coords(json.loads(gj)),
        })

    payload = json.dumps(
        {"type": "FeatureCollection", "features": features}
    ).encode("utf-8")

    with _LOCK:
        _CACHE[ckey] = payload
        _CACHE.move_to_end(ckey)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return payload

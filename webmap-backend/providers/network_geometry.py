"""Per-canton network geometry, built on demand from the ``network_links`` table.

The v2 duckdb also ships a precomputed ``merged_segments:{cid}`` static_asset,
but that blob is *thin* — only ``link_id``/``road_type``/``freespeed``. The road
"Volumes" and "MATSim Network" modules need ``modes`` (the car-only mode filter)
and ``capacity`` (line-width + the major-roads toggle); without them the Volumes
car filter matches nothing and the map renders blank.

``network_links`` already has ``modes``/``capacity``/``length`` plus the LV95
geometry, so we rebuild the FeatureCollection the frontend expects. Forward and
reverse links that share the same 2D geometry are **merged here** into one
feature per visual segment carrying the index-aligned ``per_id_*`` pipe arrays
(this is what the client's ``mergeSegmentsByGeometry`` used to do on every canton
load — doing it server-side ships each shared geometry once instead of twice, so
the payload roughly halves, and the work is computed once per (dataset, canton)
and shared across users instead of re-run in every browser). The client merge
now no-ops on this output (it sees ``per_id_keys`` already present) and stays
active only for the GitHub-CDN fallback shape. Geometry is reprojected LV95
(EPSG:2056) → WGS84 and coordinates are rounded to ~0.1 m. Cached per (dataset,
canton).
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict

from .connection import get_source_cursor
from .paths import dataset_key
from .zone_registry import get_registry, zone_col

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


def _flat_coords(geom: dict):
    """Flatten a LineString/MultiLineString geometry to a [[x, y], ...] list."""
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "LineString":
        return c
    if t == "MultiLineString":
        return [pt for line in c for pt in line]
    return None


def _arrow_for_coords(coords) -> str:
    """Direction glyph for one link from its own coordinates — the Python twin of
    the frontend's ``arrowForCoords``. Westward (start lon > end lon) → ``←``,
    otherwise ``→``; falls back to latitude for (near-)vertical links so a
    reversed pair still gets opposite glyphs."""
    if not coords or len(coords) < 2:
        return "→"
    s_lon, s_lat = coords[0][0], coords[0][1]
    e_lon, e_lat = coords[-1][0], coords[-1][1]
    if s_lon != e_lon:
        return "←" if s_lon > e_lon else "→"
    return "←" if s_lat > e_lat else "→"


def _geometry_key(coords) -> str:
    """Direction-independent geometry key — the Python twin of the frontend's
    ``geometryKey``: the smaller of the forward and reversed coordinate
    sequences, so a link and its reversed-coordinate twin hash to one bucket.
    Coords are already rounded deterministically, so the pairing is exact."""
    parts = [f"{x},{y}" for x, y in coords]
    fwd = ";".join(parts)
    rev = ";".join(reversed(parts))
    return fwd if fwd <= rev else rev


def _js_num(v) -> str:
    """Stringify a per-link scalar the way the old client merge effectively did
    (JSON number → JS ``toString``): integral floats lose the trailing ``.0`` so
    the ``per_id_*`` strings and anything reading them stay byte-identical to the
    previous client-side output. ``None`` → empty string (dropped by the
    frontend's ``parsePipeList``/``pipeMinMax``)."""
    if v is None:
        return ""
    f = float(v)
    return str(int(f)) if f == int(f) else repr(f)


def merged_segments_geojson(canton_id: int) -> bytes | None:
    """Return the zone (canton)'s network as serialized GeoJSON bytes, or None if
    the ``network_links`` table is unavailable (older datasets → caller falls
    back to the thin static_asset blob). ``canton_id`` is the primary zone id."""
    ckey = (dataset_key(), canton_id)
    with _LOCK:
        hit = _CACHE.get(ckey)
        if hit is not None:
            _CACHE.move_to_end(ckey)
            return hit

    try:
        cur = get_source_cursor("synthetic")
        zcol = zone_col("synthetic", "network_links", "zone")
        crs = get_registry().crs
        rows = cur.execute(
            f"""
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
                       ST_Transform(geom, '{crs}', 'EPSG:4326', always_xy := true)
                   ) AS gj
            FROM network_links
            WHERE {zcol} = ?
            """,
            [canton_id],
        ).fetchall()
    except Exception:
        return None  # table absent / incompatible dataset → fall back to blob
    if not rows:
        return None

    # Group directed links by shared 2D geometry (forward + reverse → one
    # segment). Insertion order is SQL row order, so the per_id_* arrays come out
    # in the same order the old client merge produced.
    groups: "OrderedDict[str, dict]" = OrderedDict()
    singletons = []  # degenerate geometries that can't merge; appended as-is
    for link_id, modes, capacity, freespeed, length, permlanes, road_type, gj in rows:
        if not gj:
            continue
        geom = _round_coords(json.loads(gj))
        coords = _flat_coords(geom)
        rep = {
            "link_id": link_id,
            "modes": modes,
            "capacity": capacity,
            "freespeed": freespeed,
            "length": length,
            "permlanes": permlanes,
            "road_type": road_type,
        }
        if not coords or len(coords) < 2:
            # Can't form a geometry key — keep as a standalone per-link feature so
            # it still parses (carries no per_id_*; won't be clickable-merged).
            singletons.append({"type": "Feature", "properties": rep, "geometry": geom})
            continue
        key = _geometry_key(coords)
        grp = groups.get(key)
        if grp is None:
            grp = {"geometry": geom, "rep": rep,
                   "keys": [], "arrows": [], "freespeeds": [],
                   "capacities": [], "lengths": [], "permlanes": []}
            groups[key] = grp
        grp["keys"].append(str(link_id))
        grp["arrows"].append(_arrow_for_coords(coords))
        grp["freespeeds"].append(_js_num(freespeed))
        grp["capacities"].append(_js_num(capacity))
        grp["lengths"].append(_js_num(length))
        grp["permlanes"].append(_js_num(permlanes))

    # Merged segments first so features[0] always carries per_id_keys — the
    # frontend's no-op guard only inspects the first feature.
    features = []
    for grp in groups.values():
        features.append({
            "type": "Feature",
            "properties": {
                **grp["rep"],
                "per_id_keys": "|".join(grp["keys"]),
                "per_id_arrows": "|".join(grp["arrows"]),
                "per_id_freespeeds": "|".join(grp["freespeeds"]),
                "per_id_capacities": "|".join(grp["capacities"]),
                "per_id_lengths": "|".join(grp["lengths"]),
                "per_id_permlanes": "|".join(grp["permlanes"]),
            },
            "geometry": grp["geometry"],
        })
    features.extend(singletons)

    payload = json.dumps(
        {"type": "FeatureCollection", "features": features}
    ).encode("utf-8")

    with _LOCK:
        _CACHE[ckey] = payload
        _CACHE.move_to_end(ckey)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return payload

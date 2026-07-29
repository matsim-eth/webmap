"""Per-canton network geometry: the dataset's precomputed asset when it has one,
otherwise rebuilt on demand from the ``network_links`` table.

**v3 datasets** ship a *fat* ``merged_segments:{cid}`` static_asset — already
merged, carrying the full property set — and it is served straight through
(~1.8 s for a 50 MB canton, vs ~24 s to rebuild the identical bytes).

**v2 datasets** ship a *thin* blob of the same name: only
``link_id``/``road_type``/``freespeed``, one unmerged feature per directed link.
The road "Volumes" and "MATSim Network" modules need ``modes`` (the car-only mode
filter) and ``capacity`` (line-width + the major-roads toggle); without them the
Volumes car filter matches nothing and the map renders blank. So a thin asset is
rejected by :func:`_is_fat` and the rebuild below runs instead.

The rebuild is **transitional** — see the note on :func:`merged_segments_geojson`
for what to delete once every dataset ships the fat asset.

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


# Markers that identify a *fat* (v3) ``merged_segments:{cid}`` asset — one that
# already carries the merge and the full property set. The legacy thin export
# has none of them (it is one unmerged feature per directed link with only
# link_id/road_type/freespeed), so any one would do; all three are checked so a
# half-migrated export can't be mistaken for a complete one.
_FAT_MARKERS = (b'"per_id_keys"', b'"modes"', b'"capacity"')
# The first feature's properties sit at the head of the document, well inside
# this window (~500 bytes in practice). Sniffing a bounded slice keeps the check
# O(1) instead of parsing 50 MB of JSON just to answer "is this the new format?".
_SNIFF_BYTES = 65536


def _is_fat(payload: bytes) -> bool:
    head = payload[:_SNIFF_BYTES]
    return all(m in head for m in _FAT_MARKERS)


def _stored_merged_segments(canton_id: int) -> bytes | None:
    """The precomputed ``merged_segments:{cid}`` asset, if this dataset ships the
    fat (v3) version. None → dataset predates the export change, rebuild instead."""
    from .helpers import load_static_asset_bytes

    try:
        payload = load_static_asset_bytes("synthetic", f"merged_segments:{canton_id}")
    except Exception:
        return None
    if payload is None or not _is_fat(payload):
        return None
    return payload


def merged_segments_geojson(canton_id: int, major: bool = False) -> bytes | None:
    """Return the zone (canton)'s network as serialized GeoJSON bytes, or None if
    the network is unavailable for this dataset. ``canton_id`` is the primary
    zone id.

    ``major=True`` returns only major roads, the same subset the frontend's
    ``MAJOR_ROADS_FILTER`` displays (see :func:`major_road_clause`). The road
    "Volumes" module defaults to that view, and it is ~5× less of everything —
    Zürich: 33,756 features / 3.8 MB of geometry against 180,719 / 20.4 MB — so
    the browser downloads, parses and tiles a fraction of the network for the
    view it actually shows. Variants are cached separately.

    Prefers the dataset's precomputed ``merged_segments:{cid}`` asset, which v3
    exports ship already merged and fully propertied — verified byte-identical to
    :func:`_rebuild_from_network_links` output, at ~1.8 s instead of ~24 s.

    .. note:: **The rebuild path below is transitional.** It exists only for
       datasets exported before the merged_segments export was fixed (datasets
       1–3 still carry the thin 3-property blob). Once every dataset in use ships
       the fat asset, delete ``_rebuild_from_network_links`` and everything it
       pulls in (``_round_coords``, ``_flat_coords``, ``_arrow_for_coords``,
       ``_geometry_key``, ``_js_num``) — this module then collapses to a cached
       blob read. Check for thin assets before removing it: an asset is thin if
       ``features[0].properties`` lacks ``per_id_keys``/``modes``/``capacity``.
    """
    ckey = (dataset_key(), canton_id, major)
    with _LOCK:
        hit = _CACHE.get(ckey)
        if hit is not None:
            _CACHE.move_to_end(ckey)
            return hit

    payload = _stored_merged_segments(canton_id)
    if payload is not None and major:
        # The stored asset is always the whole network; subset it here. Costs one
        # parse + re-serialise, paid once per (dataset, zone) because the result
        # is cached below — still far cheaper than shipping 5× the features.
        # A corrupt/truncated asset makes this return None; fall through to the
        # rebuild rather than 404ing, so a bad blob can't kill the major-roads
        # view for a zone whose unfiltered view still works.
        payload = _filter_major(payload)
    if payload is None:
        payload = _rebuild_from_network_links(canton_id, major=major)
    if payload is None:
        return None

    with _LOCK:
        _CACHE[ckey] = payload
        _CACHE.move_to_end(ckey)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return payload


def _filter_major(payload: bytes) -> bytes | None:
    """Major-roads subset of an already-serialized FeatureCollection.

    Used for the fat (v3) stored asset, which ships the whole network. Its
    features are already merged, so the test applies to the segment's scalar
    props exactly as the client's MAJOR_ROADS_FILTER does — `road_type` when
    usable, else the `capacity > 1200` fallback — and whole segments are kept or
    dropped together, matching the rebuild path's node-pair grouping.
    """
    from .link_speeds import MAJOR_ROAD_TYPES

    try:
        fc = json.loads(payload)
    except Exception:
        return None
    major = set(MAJOR_ROAD_TYPES)

    def keep(props: dict) -> bool:
        rt = props.get("road_type")
        if isinstance(rt, str) and rt and rt != "unknown":
            return rt in major
        cap = props.get("capacity")
        return isinstance(cap, (int, float)) and cap > 1200

    fc["features"] = [f for f in fc.get("features", []) if keep(f.get("properties") or {})]
    return json.dumps(fc).encode()


def _rebuild_from_network_links(canton_id: int, major: bool = False) -> bytes | None:
    """Rebuild the merged FeatureCollection from ``network_links``.

    TRANSITIONAL — see the note on :func:`merged_segments_geojson`. Returns None
    when the table is unavailable/incompatible.

    ``major`` narrows the query to major roads. Everything downstream (the
    ST_AsGeoJSON, the Python merge loop, the json.dumps) scales with row count,
    so the filtered rebuild is roughly 5× cheaper rather than more expensive.

    The filter keeps every link sharing an (undirected) node pair with a major
    link, not merely the major links themselves. Merging is by geometry and
    links with the same geometry necessarily share endpoints, so the node pair
    is a superset of each merge group — which is what makes the subset agree
    *exactly* with the client's MAJOR_ROADS_FILTER. That filter tests a merged
    segment's representative link (the first in row order), so it keeps whole
    segments; filtering per link instead would strip the non-major members of a
    mixed segment, e.g. the `service` link that shares a geometry with a
    `primary` pair. Zürich: 45 of 80,859 merge groups are mixed, so the wider
    rule costs 31 extra links and ~0.1 s.
    """
    from .link_speeds import major_road_clause

    try:
        cur = get_source_cursor("synthetic")
        zcol = zone_col("synthetic", "network_links", "zone")
        crs = get_registry().crs
        if major:
            clause, major_args = major_road_clause()
            # Flag whole node-pair groups, then keep them. The window runs over
            # plain columns, so the geometry transform below only touches rows
            # that survive.
            source = f"""(
                SELECT *, MAX(CASE WHEN {clause} THEN 1 ELSE 0 END) OVER (
                    PARTITION BY least(from_node, to_node), greatest(from_node, to_node)
                ) AS grp_major
                FROM network_links WHERE {zcol} = ?
            )"""
            where = "grp_major = 1"
            params = [*major_args, canton_id]
        else:
            source = "network_links"
            where = f"{zcol} = ?"
            params = [canton_id]
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
            FROM {source}
            WHERE {where}
            """,
            params,
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

    # Caching is the caller's job (merged_segments_geojson) so the stored-asset
    # and rebuilt paths share one cache entry per (dataset, zone).
    return json.dumps(
        {"type": "FeatureCollection", "features": features}
    ).encode("utf-8")

"""Per-line slices of the large `transit_routes` GeoJSON asset.

Serving the whole `transit_routes` static asset (every route variant of every
line in the country — ~21k features / ~76 MB) just to draw one selected line
forced the browser to download + parse all of it: a multi-second lag before the
line appeared, and a race that sometimes cleared the selection before the
geometry arrived.

Here we parse the asset once per dataset, group features by `line_id`,
pre-serialise each line's FeatureCollection, then drop the parsed asset — so we
hold roughly the asset's own byte size in memory, not the (much larger) parsed
Python form. Each request is then a dict lookup returning tens of KB.
"""

from __future__ import annotations

import json
import threading
from collections import Counter, defaultdict

from .helpers import load_static_asset
from .paths import dataset_key, dataset_root_path

_EMPTY = b'{"type":"FeatureCollection","features":[]}'

# dataset_key -> {line_id: pre-serialised FeatureCollection bytes}. Keyed per
# dataset so a worker serving several datasets never mixes their geometry.
_ds_cache: dict[str, dict[str, bytes]] = {}
_lock = threading.Lock()

# dataset_key -> {line_id: {"H"|"R": [(lon, lat) route-end coordinates]}}.
# Collected as a side product of the _index parse (one entry per route
# variant); feeds route_directions() below.
_ends_cache: dict[str, dict[str, dict[str, list]]] = {}

# dataset_key -> the finished route_directions() payload.
_rd_cache: dict[str, dict] = {}
_rd_lock = threading.Lock()


def _route_end(geometry: dict) -> list | None:
    """Last coordinate of a route geometry (LineString or MultiLineString)."""
    if not geometry:
        return None
    coords = geometry.get("coordinates")
    if not coords:
        return None
    if geometry.get("type") == "MultiLineString":
        coords = coords[-1]
        if not coords:
            return None
    pt = coords[-1]
    return pt if isinstance(pt, (list, tuple)) and len(pt) >= 2 else None


def _index() -> dict[str, bytes]:
    """Build (once per dataset) and return the line_id -> FeatureCollection-bytes
    map. Double-checked locking so parallel first-requests collapse onto one
    parse of the ~76 MB asset instead of stampeding it."""
    dk = dataset_key()
    idx = _ds_cache.get(dk)
    if idx is not None:
        return idx
    with _lock:
        idx = _ds_cache.get(dk)
        if idx is None:
            fc = load_static_asset("synthetic", "transit_routes") or {}
            by_line: dict[str, list] = defaultdict(list)
            ends: dict[str, dict[str, list]] = {}
            for f in fc.get("features", []):
                props = f.get("properties") or {}
                lid = props.get("line_id")
                if lid is None:
                    continue
                by_line[lid].append(f)
                # Route direction from the route_id suffix (.H/.R) + the
                # geometry's end point — the raw material for the per-line
                # direction terminus labels (route_directions()).
                rid = props.get("route_id") or ""
                direction = "H" if rid.endswith(".H") else "R" if rid.endswith(".R") else None
                if direction:
                    end = _route_end(f.get("geometry"))
                    if end is not None:
                        ends.setdefault(lid, {}).setdefault(direction, []).append(end)
            idx = {
                lid: json.dumps(
                    {"type": "FeatureCollection", "features": feats}
                ).encode("utf-8")
                for lid, feats in by_line.items()
            }
            _ends_cache[dk] = ends
            _ds_cache[dk] = idx
        return idx


def routes_for_line_bytes(line_id: str) -> bytes:
    """Pre-serialised GeoJSON FeatureCollection of every route geometry for
    *line_id* (empty FeatureCollection if the line has no geometry)."""
    return _index().get(line_id, _EMPTY)


# dataset_keys for which a background warm has been kicked off, so repeated
# transit requests don't each spawn a thread.
_warming: set[str] = set()
_warm_lock = threading.Lock()


def ensure_warm() -> None:
    """Build the per-line index in a background daemon thread (once per dataset)
    so the first line selection doesn't block on the ~6 s parse of the ~76 MB
    routes asset. Safe to call on every transit request: no-ops once the index
    is built or a warm is already in flight.

    Lazy by design — only datasets whose transit module is actually opened pay
    the memory/parse cost, and the warm is triggered when stops first load (a
    canton click), so it's typically ready before the user clicks a line.
    Captures the current dataset root and re-applies it inside the thread (the
    per-request ContextVar override doesn't propagate to a new thread)."""
    dk = dataset_key()
    root = dataset_root_path()  # raw path for the override (dk is version-tagged)
    with _warm_lock:
        if dk in _ds_cache or dk in _warming:
            return
        _warming.add(dk)

    def _run(root: str) -> None:
        from .paths import set_root_override
        set_root_override(root)
        try:
            _index()
        except Exception:
            pass
        finally:
            set_root_override(None)
            with _warm_lock:
                _warming.discard(dk)

    threading.Thread(
        target=_run, args=(root,), daemon=True, name="warm-transit-routes"
    ).start()


def route_directions() -> dict | None:
    """Per-line direction metadata for the .H/.R route-direction filter:

        {line_id: {"H": {"terminus": "Sursee", "coord": [lon, lat], "n_routes": 18},
                   "R": {"terminus": "Baar",   "coord": [lon, lat], "n_routes": 21}}}

    The terminus is the MOST COMMON end-of-route stop name among the line's
    route variants in that direction: each route geometry's last coordinate is
    matched to the nearest of the line's stops (names + coordinates from the
    boarding_data asset, coordinates resolved through the network like
    transit_stops does). A line's route variants can end at different stops
    (short-turning services), hence the majority vote.

    `coord` is the winning stop's own coordinate (the modal snapped-stop
    location among the endpoints that voted for the terminus name). Returning it
    lets the frontend place the terminus MARKER on exactly the stop the label
    names, instead of independently recomputing a modal raw endpoint — the two
    used to diverge whenever a station's platforms split the coordinate vote.

    Cached per dataset. Returns None when the dataset can't provide the inputs
    (no transit_routes asset / no boarding data) so the bridge can 404.

    Prefers the precomputed `route_directions` static_asset when the dataset
    ships one (the export now weights the terminus by real departure frequency
    and adds `origin`/`origin_coord`/`share`/`alternates`); the runtime vote
    below is the fallback for older datasets built without that asset.
    """
    import math

    dk = dataset_key()
    cached = _rd_cache.get(dk)
    if cached is not None:
        return cached or None
    with _rd_lock:
        cached = _rd_cache.get(dk)
        if cached is not None:
            return cached or None

        # Precomputed asset (v2 export): serve as-is — it's a superset of the
        # runtime shape (terminus/coord/n_routes) plus the frequency-weighted
        # fields, and the frontend already reads only what it needs.
        precomputed = load_static_asset("synthetic", "route_directions")
        if precomputed:
            _rd_cache[dk] = precomputed
            return precomputed

        _index()  # ensures _ends_cache[dk] is populated
        ends = _ends_cache.get(dk) or {}
        if not ends:
            _rd_cache[dk] = {}
            return None

        from .boarding_data import BoardingDataProvider
        from .connection import get_source_cursor
        from .transit_stops import _linkid, _resolve_coords

        try:
            lines = BoardingDataProvider()._load()
        except FileNotFoundError:
            _rd_cache[dk] = {}
            return None

        # stop name + pt-link per line, and every link id once for one coord
        # resolution query (the dominant cost — a single network_links scan).
        line_stops: dict[str, list] = {}
        all_links: set[str] = set()
        for line in lines:
            lid = line.get("line_id")
            if lid not in ends:
                continue
            pairs = []
            for s in line.get("stops", []):
                lk = _linkid(s.get("stop_id") or "")
                if lk:
                    pairs.append((s.get("name"), lk))
                    all_links.add(lk)
            if pairs:
                line_stops[lid] = pairs

        coords = _resolve_coords(get_source_cursor("synthetic"), list(all_links))

        result: dict[str, dict] = {}
        for lid, dirs in ends.items():
            stops = [
                (name, coords[lk]) for name, lk in line_stops.get(lid, [])
                if lk in coords and name
            ]
            if not stops:
                continue
            entry = {}
            for direction, endpoints in dirs.items():
                votes: dict[str, int] = {}
                # name -> Counter of the snapped stop coordinates seen for it, so
                # the winning name's marker coord is an actual stop location and
                # stays consistent with the label (platforms sharing a name are
                # aggregated here just as the name vote aggregates them).
                coord_votes: dict[str, Counter] = {}
                for ex, ey in (e[:2] for e in endpoints):
                    # planar nearest with a cos(lat) x-scale — fine at stop
                    # spacing; picks the stop the route geometry ends at.
                    cx = math.cos(math.radians(ey))
                    name, coord = min(
                        stops,
                        key=lambda s: ((s[1][0] - ex) * cx) ** 2 + (s[1][1] - ey) ** 2,
                    )
                    votes[name] = votes.get(name, 0) + 1
                    coord_votes.setdefault(name, Counter())[coord] += 1
                if votes:
                    terminus = max(votes.items(), key=lambda kv: kv[1])[0]
                    tx, ty = coord_votes[terminus].most_common(1)[0][0]
                    entry[direction] = {
                        "terminus": terminus,
                        "coord": [tx, ty],
                        "n_routes": len(endpoints),
                    }
            if entry:
                result[lid] = entry

        _rd_cache[dk] = result
        return result or None

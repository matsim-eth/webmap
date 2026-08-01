"""Per-zone network geometry, served from the dataset's precomputed asset.

Every dataset ships a ``merged_segments:{zone_id}`` static_asset per primary
zone: one feature per visual road segment, already merged (forward + reverse
links sharing a 2D geometry collapsed into one feature carrying the
index-aligned ``per_id_*`` pipe arrays), carrying the full property set
(``modes``, ``capacity``, ``length``, ``permlanes``, ``road_type``, km/h
``freespeed``), reprojected to WGS84. Serving it is a blob read plus, for
``?major=1``, one filter pass.

Who writes the asset:
  * the Swiss-wide export (eqasim ``webmap_export``), keyed by canton;
  * ``dataset-backend/rezone.py:_build_merged_segments`` for a re-zoned study
    area, keyed by its primary zone (gemeinde/bezirk) — the source's
    canton-keyed assets can't be reused, so they are rebuilt from that
    dataset's own ``network_links``.

This module used to rebuild the FeatureCollection from ``network_links`` on
demand, for datasets exported before the asset existed. That path is gone: all
datasets now ship the asset, and the merge itself lives in ``rezone.py``, run
once at build time rather than on every cold zone request (~11 s per canton).
A dataset with no asset for a zone returns None → 404 → the frontend's
``loadWithFallback`` tries the GitHub CDN.
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict

from .paths import dataset_key

# Serialized GeoJSON bytes per (dataset, zone, variant). Each zone can be large
# (canton Zurich ~178k links → tens of MB), so this is a small bounded LRU.
_CACHE: "OrderedDict[tuple, bytes]" = OrderedDict()
_CACHE_MAX = 6
_LOCK = threading.Lock()


def _stored_merged_segments(canton_id: int) -> bytes | None:
    """The dataset's precomputed ``merged_segments:{cid}`` asset, or None."""
    from .helpers import load_static_asset_bytes

    try:
        return load_static_asset_bytes("synthetic", f"merged_segments:{canton_id}")
    except Exception:
        return None


def merged_segments_geojson(canton_id: int, major: bool = False) -> bytes | None:
    """Return the zone's network as serialized GeoJSON bytes, or None if this
    dataset ships no asset for it. ``canton_id`` is the primary zone id.

    ``major=True`` returns only major roads, the same subset the frontend's
    ``MAJOR_ROADS_FILTER`` displays (see :func:`major_road_clause`). The road
    "Volumes" module defaults to that view, and it is ~5× less of everything —
    Zürich: 33,756 features / 3.8 MB of geometry against 180,719 / 20.4 MB — so
    the browser downloads, parses and tiles a fraction of the network for the
    view it actually shows. Variants are cached separately.
    """
    ckey = (dataset_key(), canton_id, major)
    with _LOCK:
        hit = _CACHE.get(ckey)
        if hit is not None:
            _CACHE.move_to_end(ckey)
            return hit

    payload = _stored_merged_segments(canton_id)
    if payload is None:
        return None
    if major:
        # The stored asset is always the whole network; subset it here. Costs one
        # parse + re-serialise, paid once per (dataset, zone) because the result
        # is cached below — still far cheaper than shipping 5× the features.
        payload = _filter_major(payload)

    with _LOCK:
        _CACHE[ckey] = payload
        _CACHE.move_to_end(ckey)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return payload


def _filter_major(payload: bytes) -> bytes:
    """Major-roads subset of an already-serialized FeatureCollection.

    The stored asset's features are already merged, so the test applies to the
    segment's scalar props exactly as the client's MAJOR_ROADS_FILTER does —
    `road_type` when usable, else the `capacity > 1200` fallback — keeping or
    dropping whole segments together.

    A corrupt/truncated asset returns the payload unfiltered rather than None:
    the client applies MAJOR_ROADS_FILTER to whatever it receives, so the view
    is still correct (just larger), whereas 404ing would fall through to the
    CDN and hand this dataset a *different* dataset's network.
    """
    from .link_speeds import MAJOR_ROAD_TYPES

    try:
        fc = json.loads(payload)
    except Exception:
        return payload
    major = set(MAJOR_ROAD_TYPES)

    def keep(props: dict) -> bool:
        rt = props.get("road_type")
        if isinstance(rt, str) and rt and rt != "unknown":
            return rt in major
        cap = props.get("capacity")
        return isinstance(cap, (int, float)) and cap > 1200

    fc["features"] = [f for f in fc.get("features", []) if keep(f.get("properties") or {})]
    return json.dumps(fc).encode()

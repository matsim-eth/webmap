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
from collections import defaultdict

from .helpers import load_static_asset
from .paths import dataset_key

_EMPTY = b'{"type":"FeatureCollection","features":[]}'

# dataset_key -> {line_id: pre-serialised FeatureCollection bytes}. Keyed per
# dataset so a worker serving several datasets never mixes their geometry.
_ds_cache: dict[str, dict[str, bytes]] = {}
_lock = threading.Lock()


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
            for f in fc.get("features", []):
                lid = (f.get("properties") or {}).get("line_id")
                if lid is not None:
                    by_line[lid].append(f)
            idx = {
                lid: json.dumps(
                    {"type": "FeatureCollection", "features": feats}
                ).encode("utf-8")
                for lid, feats in by_line.items()
            }
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
        target=_run, args=(dk,), daemon=True, name="warm-transit-routes"
    ).start()

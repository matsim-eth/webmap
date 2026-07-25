"""Distinct **network-link** transport modes per zone.

The MATSim Network / Volumes mode filter needs the modes the canton's *links*
permit (``car,car_passenger,truck``, ``rail``, ``tram``, …). Two existing
sources are both wrong for that job:

* ``modes_by_canton.json`` is **trip**-based (``hot_polygon_trips``) and its
  vocabulary is hardcoded to five columns — car/pt/walk/bike/car_passenger — so
  a detailed network's truck/rail/tram links are silently invisible.
* The frontend used to union ``properties.modes`` over the loaded
  ``merged_segments`` FeatureCollection. Correct, but it blocks the dropdown on
  a tens-of-MB on-demand geometry rebuild (``network_geometry.py``), so the
  filter sits on "All" for as long as that takes.

``modes`` is a plain ``VARCHAR`` column on ``network_links``, so a
``DISTINCT (zone, modes)`` never touches ``geom``, never calls ``ST_Transform``
and never round-trips through Python per link — it is a narrow columnar scan,
milliseconds even on a multi-million-link network. The whole zone→modes map is
built in one scan and cached per dataset, so every zone is served from the
first request onwards.

Response shape mirrors ``modes_by_canton.json`` — ``{zone_name: [modes]}`` —
so callers that want the entire study area can omit ``?canton=``.

An empty ``{}`` means "this dataset can't answer" (no ``network_links`` table,
e.g. a legacy CDN-backed dataset); the frontend then falls back to the
geometry-derived union.
"""

from __future__ import annotations

import threading
from collections import OrderedDict

from .base import CANTON, ZONE, DataProvider
from .connection import get_source_cursor
from .paths import dataset_key
from .zone_registry import get_registry, zone_col

# {dataset_key: {zone_name: [modes]}}. Tiny (a few dozen strings per dataset),
# but bounded anyway since a worker may serve many datasets.
_CACHE: "OrderedDict[str, dict[str, list[str]]]" = OrderedDict()
_CACHE_MAX = 16
_LOCK = threading.Lock()


def _build() -> dict[str, list[str]]:
    """One narrow scan of ``network_links`` → {zone_name: sorted modes}."""
    cur = get_source_cursor("synthetic")
    zcol = zone_col("synthetic", "network_links", "zone")
    # DISTINCT collapses to one row per (zone, mode-combo); `modes` is a
    # comma-joined combo string, so the result set is a few dozen rows at most.
    rows = cur.execute(
        f"SELECT DISTINCT {zcol}, modes FROM network_links"
    ).fetchall()

    reg = get_registry()
    acc: dict[str, set[str]] = {}
    for zid, modes in rows:
        if zid is None or not modes:
            continue
        bucket = acc.setdefault(reg.zone_name(zid), set())
        for part in str(modes).split(","):
            m = part.strip()
            if m:
                bucket.add(m)
    return {name: sorted(ms) for name, ms in acc.items()}


def network_modes() -> dict[str, list[str]]:
    """Cached zone→modes map for the dataset in scope.

    Never raises. A failed or empty build is deliberately **not** cached: the
    query is cheap, and caching a transient miss would pin the dropdown to its
    fallback for the rest of the worker's life.
    """
    key = dataset_key()
    with _LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return hit

    try:
        built = _build()
    except Exception:
        return {}  # table/column absent → caller falls back
    if not built:
        return {}

    with _LOCK:
        _CACHE[key] = built
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return built


class NetworkModesProvider(DataProvider):
    ROUTE = "network_modes.json"
    PARAMS = [CANTON, ZONE]

    def deliver(self, params: dict) -> dict:
        all_modes = network_modes()
        raw = params.get("canton") or params.get("zone")
        if not raw:
            return dict(all_modes)

        reg = get_registry()
        out: dict[str, list[str]] = {}
        for tok in str(raw).split(","):
            zid = reg.resolve_zone(tok.strip())
            if zid is None:
                continue
            name = reg.zone_name(zid)
            # Known zone with no links → [] (an explicit "none", not a miss).
            out[name] = all_modes.get(name, [])
        return out

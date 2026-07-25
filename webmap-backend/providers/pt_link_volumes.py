"""Per-canton PT link volumes rebuilt from the `pt_link_volumes` duckdb table.

Replaces the CDN's preprocessed
``transit/volumes_by_link_line/pt_link_volumes_by_link_line_{canton}.json`` —
historically the only webmap asset that could NOT be rebuilt from the dataset's
own duckdb (link_speeds/spider are car-only). Datasets built with the
`pt_link_volumes` table (one row per link/line/route/15-min bin) now serve it
themselves; older datasets raise → the matsim bridge 404s → the frontend falls
back to the CDN as before.

Output matches the CDN shape the frontend already parses
(`useTransitVolumesLayer.toVolumeById` / `TransitLinkHistogram`):

    [{"link_id": ..., "modes_list": [...],
      "lines": [{"line_id", "line_name", "mode",
                 "hourly_avg_volumes": {"HH:MM": v, ...},   # both directions
                 "directions": {"H": {...}, "R": {...}}}]}]  # per route suffix

`directions` is new: per-15-min bins split by the route_id suffix (`.H`/`.R`),
which powers the direction filter in the Transit Volumes module. CDN files
don't carry it — the frontend treats a missing `directions` as "no direction
data" and leaves the filter inert.
"""

from __future__ import annotations

from collections import OrderedDict

from .connection import get_source_cursor
from .paths import dataset_key

# Bounded per-(dataset, canton) LRU — a large canton's result is tens of MB of
# Python objects (Zurich ~31k links / ~59k link-line pairs), so keep few.
_VOL_CACHE: "OrderedDict[tuple, list]" = OrderedDict()
_VOL_CACHE_MAX = 4

# time_bin (0..95) → "HH:MM" label, precomputed once.
_TICK_KEYS = [f"{b // 4:02d}:{(b % 4) * 15:02d}" for b in range(96)]


def volumes_by_link_line(canton_id: int) -> list | None:
    """Rebuild the per-canton PT link volume rows from `pt_link_volumes`.

    Returns None when the dataset has no `pt_link_volumes` table (older
    duckdbs) so the caller can 404 and let the frontend fall back to the CDN.
    """
    key = (dataset_key(), canton_id)
    hit = _VOL_CACHE.get(key)
    if hit is not None:
        _VOL_CACHE.move_to_end(key)
        return hit

    cur = get_source_cursor("synthetic")
    try:
        rows = cur.execute(
            r"""
            SELECT link_id, line_id,
                   any_value(line_name), any_value(mode),
                   regexp_extract(route_id, '\.([HR])$', 1) AS dir,
                   time_bin, SUM(volume)
            FROM pt_link_volumes
            WHERE canton_id = ?
            GROUP BY link_id, line_id, dir, time_bin
            """,
            [canton_id],
        ).fetchall()
    except Exception:
        return None  # table absent in this dataset

    # link_id → {"modes": set, "lines": {line_id: {...}}}
    links: dict[str, dict] = {}
    for link_id, line_id, line_name, mode, direction, time_bin, volume in rows:
        # Skip malformed rows rather than raising — the matsim bridge masks any
        # exception here as a 404, and datasets that ship this table (≥3) have no
        # CDN fallback, so one bad row must not blank the whole overlay.
        if time_bin is None or not (0 <= time_bin < len(_TICK_KEYS)):
            continue
        link = links.get(link_id)
        if link is None:
            link = links[link_id] = {"modes": set(), "lines": {}}
        if mode:
            link["modes"].add(mode)
        line = link["lines"].get(line_id)
        if line is None:
            line = link["lines"][line_id] = {
                "line_id": line_id,
                "line_name": line_name,
                "mode": mode,
                "hourly_avg_volumes": {},
                "directions": {},
            }
        tk = _TICK_KEYS[time_bin]
        vol = int(volume or 0)
        bins = line["hourly_avg_volumes"]
        bins[tk] = bins.get(tk, 0) + vol
        if direction:
            dbins = line["directions"].setdefault(direction, {})
            dbins[tk] = dbins.get(tk, 0) + vol

    out = [
        {
            "link_id": link_id,
            "modes_list": sorted(link["modes"]),
            "lines": list(link["lines"].values()),
        }
        for link_id, link in links.items()
    ]

    _VOL_CACHE[key] = out
    _VOL_CACHE.move_to_end(key)
    while len(_VOL_CACHE) > _VOL_CACHE_MAX:
        _VOL_CACHE.popitem(last=False)
    return out


def stop_line_directions() -> dict[tuple[str, str], set] | None:
    """(stop pt-link id, line_id) → set of direction letters ("H"/"R") serving
    that platform, from the `pt_link_volumes` rows on `pt_*` stop pseudo-links.

    Used by `transit_stops` to tag each station-line entry with the directions
    that actually call there. None when the table is absent.
    """
    cur = get_source_cursor("synthetic")
    try:
        rows = cur.execute(
            r"""
            SELECT DISTINCT link_id, line_id,
                   regexp_extract(route_id, '\.([HR])$', 1) AS dir
            FROM pt_link_volumes
            WHERE link_id LIKE 'pt\_%' ESCAPE '\'
            """
        ).fetchall()
    except Exception:
        return None
    dirs: dict[tuple[str, str], set] = {}
    for link_id, line_id, direction in rows:
        if direction:
            dirs.setdefault((link_id, line_id), set()).add(direction)
    return dirs

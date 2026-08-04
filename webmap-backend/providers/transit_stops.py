"""Reconstruct the `transit/stops_by_canton/{canton}_stops.geojson` and
`transit/transit_modes_by_canton.json` assets straight from the v2 duckdb.

These two assets are NOT shipped in the v2 `static_assets` table, so without
this the dashboard's Transit-Stops tab falls back to the GitHub CDN, whose
stop_ids belong to a different network and never match the dataset's own
`per_canton_counts` rows — making every stop-filtered chart read 0.

Everything here is derived from data already in the duckdb:
  • stop list / names / per-stop lines  → `boarding_data_by_line` static asset
  • stop coordinates                    → the stop's `.link:<id>` pseudo-link's
                                          `to_node` in `network_nodes` (the PT
                                          stop node), transformed 2056 → 4326.

Results are cached per process (the dataset is read-only).
"""

from __future__ import annotations

import re
import threading
from collections import defaultdict

from .connection import get_source_cursor
from .paths import dataset_key
from .zone_registry import get_registry

# Leading numeric token = physical station id (platforms share it), e.g.
# "8593773:0:1.link:pt_8593773:0:1" and "8593773:0:2.link:..." → station 8593773.
_STATION_RE = re.compile(r"^(\d+)")

# dataset_key → bundle, keyed per dataset so a worker serving several datasets
# never mixes one dataset's stops into another:
#   "by_zone"  {zone_id: {station_key: station}} — the *skeleton*: every station
#              of every zone, with its stop_ids/linkids/lines, but no coords.
#   "modes"    {zone_name: [mode, ...]}
#   "coords"   {link_id: (lon, lat)} — filled incrementally, zone by zone.
#   "fc"       {zone_id: FeatureCollection} — built on demand from the two above.
#   "inter"    FeatureCollection | None
#   "all_coords"  True once every link has been resolved (so `inter` is buildable)
_ds_cache: dict[str, dict] = {}

# Serialises skeleton construction and coordinate fills, so N concurrent
# first-requests for different zones don't each kick off the same scan
# (thundering herd). The first request builds; the rest wait and reuse it.
#
# **Per dataset**, not global. A single shared lock meant one dataset's build
# blocked every other dataset's: the warm thread holding it for the 139 s
# `inter_cantonal_stops()` of one dataset stalled a user opening a *different*
# one for the whole duration, which reads exactly like "transit stops are slow"
# even though that user's own dataset builds in ~1.5 s. Datasets share nothing
# here — separate bundles, separate duckdb files — so they must not share a lock.
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(dk: str) -> threading.Lock:
    with _locks_guard:
        lk = _locks.get(dk)
        if lk is None:
            lk = _locks[dk] = threading.Lock()
        return lk

# dataset_key → {canton_name: [mode, ...]}. Populated by the *light* modes-only
# path (see transit_modes) so the mode dropdown never waits on a full _build().
_modes_cache: dict[str, dict] = {}
_modes_lock = threading.Lock()


def _zone_col() -> str:
    """Primary-zone id column on ``network_links`` (v3 ``zone_id`` / legacy
    ``canton_id``), probed and cached by the registry."""
    from .zone_registry import zone_col

    return zone_col("synthetic", "network_links")


def _linkid(stop_id: str) -> str | None:
    """The network link id embedded after '.link:' in a stop_id."""
    if not stop_id or ".link:" not in stop_id:
        return None
    return stop_id.split(".link:", 1)[1]


def _resolve_coords(cur, linkids: list[str], prune: bool = False) -> dict[str, tuple]:
    """link_id → (lon, lat) via the link's to_node geometry (EPSG:2056→4326).

    One query (``IN (SELECT UNNEST(?))``) instead of chunked 800-id batches, so
    the ``network_links`` scan happens once rather than ~75 times.

    That scan is the whole cost of a cold stops build, and it is **I/O, not
    CPU**: measured on the Zurich gemeinde dataset (193k links) it is ~13 s cold
    and ~0.13 s warm — paging in `network_links`/`network_nodes`. Restricting
    the id list does nothing, because the scan is full either way; only a
    predicate on the *zone* column lets DuckDB skip row groups.

    ``prune=True`` does that in two steps:
      1. a narrow ``link_id, zone_id`` lookup (no ``geom``, so cheap) to learn
         which zones these links actually live in;
      2. the geometry join restricted to exactly those zones.

    Step 1 is what keeps this correct. The stop's zone (from the boarding asset)
    and its link's ``zone_id`` disagree for a minority of stops — 27 of 7,293 on
    the Zurich dataset — so filtering on the *caller's* zone would silently drop
    those stops from the map (they'd resolve no geometry and be skipped below).
    Asking the database which zones to open instead is exact: the pruned result
    is identical to the unpruned one, while touching 4 zones instead of 160.

    Left off (``prune=False``) for callers that resolve every link anyway, where
    step 1 would return every zone and buy nothing."""
    if not linkids:
        return {}
    linkids = list(linkids)
    crs = get_registry().crs
    where = "l.link_id IN (SELECT UNNEST(?))"
    args: list = [linkids]
    if prune:
        col = _zone_col()
        found = [
            z for (z,) in cur.execute(
                f"SELECT DISTINCT {col} FROM network_links "
                "WHERE link_id IN (SELECT UNNEST(?))",
                [linkids],
            ).fetchall()
        ]
        zones = [z for z in found if z is not None]
        if zones:
            # A NULL zone must be carried explicitly: `IN (...)` never matches
            # NULL, so without this the pruned query silently drops those links
            # — and a station whose platforms are partly NULL-zoned would keep
            # its feature but average the coordinates of only the survivors.
            # 36,903 of 1.86M links are NULL-zoned on dataset 7036833688 (120
            # stops lost in canton 2 alone), 0 on the rezoned Zurich one, which
            # is why this only shows up on some datasets.
            pred = f"l.{col} IN (SELECT UNNEST(?))"
            if len(zones) != len(found):
                pred = f"({pred} OR l.{col} IS NULL)"
            where = f"{pred} AND {where}"
            args = [zones, linkids]
    rows = cur.execute(
        f"""
        SELECT l.link_id,
               ST_X(ST_Transform(n.geom, '{crs}', 'EPSG:4326', always_xy := true)),
               ST_Y(ST_Transform(n.geom, '{crs}', 'EPSG:4326', always_xy := true))
        FROM network_links l
        JOIN network_nodes n ON n.node_id = l.to_node
        WHERE {where}
        """,
        args,
    ).fetchall()
    return {lid: (x, y) for lid, x, y in rows if x is not None and y is not None}


def _build_skeleton() -> dict:
    """Single pass over boarding_data: aggregate platforms into stations per
    zone. Returns the bundle with `by_zone`/`modes` filled and no coordinates.

    This is the *cheap* half of what used to be one `_build()`: the blob parse
    and the per-stop walk. Measured on the Zurich gemeinde dataset it is ~0.2 s
    (3.7 MB blob, 471 lines, 16,701 stop entries) against ~13 s for the coord
    resolution it no longer does. It covers **every** zone at once, because the
    boarding asset is keyed by line rather than by zone — there is no way to
    read out one zone's stops without walking all of them — so the ladder splits
    here: walk once, then pay for coordinates only where they are asked for."""
    from .boarding_data import BoardingDataProvider
    from .pt_link_volumes import stop_line_directions

    lines = BoardingDataProvider()._load()

    # (stop pt-link, line_id) → {"H","R"} route directions calling there, from
    # the pt_link_volumes table. Empty for datasets without that table — the
    # frontend treats missing/empty dirs as "no direction data" (filter inert).
    dirmap = stop_line_directions() or {}

    # canton_id -> station_key -> station dict
    by_canton: dict[int, dict[str, dict]] = defaultdict(dict)
    modes_by_canton: dict[str, set] = defaultdict(set)

    for line in lines:
        lid = line.get("line_id")
        lname = line.get("line_name")
        mode = line.get("vehicle")
        for cname in line.get("cantons") or []:
            if mode:
                modes_by_canton[cname].add(mode)
        for s in line.get("stops", []):
            cid = s.get("canton_id")
            if cid is None:
                continue
            sid = s.get("stop_id")
            if not sid:
                continue
            m = _STATION_RE.match(sid)
            skey = m.group(1) if m else sid
            station = by_canton[cid].get(skey)
            if station is None:
                station = by_canton[cid][skey] = {
                    "name": s.get("name"),
                    "stop_ids": [],
                    "linkids": [],
                    "lines": {},
                    "modes": set(),
                }
            lk = _linkid(sid)
            if sid not in station["stop_ids"]:
                station["stop_ids"].append(sid)
                if lk:
                    station["linkids"].append(lk)
            line_entry = station["lines"].get(lid)
            if line_entry is None:
                line_entry = station["lines"][lid] = {
                    "line_id": lid,
                    "line_name": lname,
                    "mode": mode,
                    "route_id": lid,
                    "dirs": set(),
                }
            # Union over the station's platforms: which route directions of
            # this line call at this station (drives the direction filter).
            if lk:
                line_entry["dirs"] |= dirmap.get((lk, lid), set())
            if mode:
                station["modes"].add(mode)

    return {
        "by_zone": dict(by_canton),
        "modes": {k: sorted(v) for k, v in modes_by_canton.items()},
        "coords": {},
        "fc": {},
        "inter": None,
        "all_coords": False,
    }


def _feature(st: dict, coords: dict) -> dict | None:
    """One station → GeoJSON point at the mean of its platforms' coordinates."""
    pts = [coords[lk] for lk in st["linkids"] if lk in coords]
    if not pts:
        # No geometry → would crash handleSelectStop (reads
        # geometry.coordinates); skip from the searchable set. Its
        # boardings still count in the zone-wide per_canton_counts.
        return None
    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [
                sum(p[0] for p in pts) / len(pts),
                sum(p[1] for p in pts) / len(pts),
            ],
        },
        "properties": {
            "name": st["name"],
            "stop_id": st["stop_ids"],
            "lines": [
                {**l, "dirs": sorted(l["dirs"])} for l in st["lines"].values()
            ],
            "modes_list": sorted(st["modes"]),
        },
    }


def _fill_coords(b: dict, links: set[str], prune: bool) -> None:
    """Resolve any of *links* not already in the bundle's coord cache.

    **The query runs unlocked**; only the dict read and the merge are guarded.
    Holding a lock across the scan is what made one slow build stall every other
    request on the same dataset: the warm thread's whole-dataset
    `inter_cantonal_stops()` took 79.8 s, and four per-zone requests (Bern,
    Schwyz, Zug, Aargau) that each needed ~2 s of their own sat behind it and
    all completed the instant it finished.

    The cost of not holding it is that two builds overlapping in time may both
    resolve some of the same links — bounded duplicate work, and `dict.update`
    is idempotent since the dataset is read-only. That is strictly better than
    serialising a 2 s request behind an 80 s one. Callers still take a lock
    keyed to *their own unit* (this zone, or `inter`), so the same zone is never
    built twice concurrently.

    Coordinates accumulate across calls, so the zones a user visits after the
    first cost only their own new links."""
    lock = _lock_for(dataset_key())
    with lock:
        missing = [lk for lk in links if lk not in b["coords"]]
    if not missing:
        return
    resolved = _resolve_coords(get_source_cursor("synthetic"), missing, prune=prune)
    with lock:
        b["coords"].update(resolved)


def _bundle() -> dict:
    """Return (building if needed) the cached skeleton for the current dataset.

    Double-checked locking: the common case (already built) is lock-free; only
    the first request per dataset takes the lock, so parallel first-requests
    collapse onto a single build instead of stampeding the DB."""
    dk = dataset_key()
    b = _ds_cache.get(dk)
    if b is not None:
        return b
    with _lock_for(dk):
        b = _ds_cache.get(dk)
        if b is None:
            b = _ds_cache[dk] = _build_skeleton()
        return b


def stops_by_canton(canton_id: int) -> dict:
    """GeoJSON FeatureCollection of transit stations in *canton_id*.

    Rung one of the ladder: builds the skeleton once, then resolves coordinates
    for **this zone only**, pruned to the zones its links actually live in. The
    whole-dataset coord scan is never triggered from here — opening a zone costs
    ~1.3 s cold on the Zurich gemeinde dataset instead of ~13 s, and later zones
    reuse whatever `coords` already holds."""
    b = _bundle()
    hit = b["fc"].get(canton_id)
    if hit is not None:
        return hit
    stations = b["by_zone"].get(canton_id)
    if not stations:
        return {"type": "FeatureCollection", "features": []}
    # Keyed to this zone, not the dataset: two users opening different zones
    # build in parallel, and neither waits on the whole-dataset `inter` build.
    with _lock_for(f"{dataset_key()}|zone:{canton_id}"):
        hit = b["fc"].get(canton_id)
        if hit is None:
            _fill_coords(
                b, {lk for st in stations.values() for lk in st["linkids"]}, prune=True
            )
            feats = [f for f in (_feature(st, b["coords"]) for st in stations.values()) if f]
            hit = b["fc"][canton_id] = {"type": "FeatureCollection", "features": feats}
        return hit


def _build_modes_only() -> dict:
    """``{canton_name: [mode, ...]}`` from the boarding asset alone.

    The mode dropdown needs only each line's mode + the cantons it serves.
    :func:`_build_skeleton` additionally walks every stop entry (~116k on a
    Swiss-wide dataset) and calls ``stop_line_directions()`` — neither of which
    the mode list depends on — so this stays the lighter path even now that the
    coord-resolution join has moved out of the skeleton and behind
    :func:`stops_by_canton`. Cost is essentially the blob fetch and JSON parse,
    so the dropdown populates while the stops are still loading.

    Deliberately reuses ``BoardingDataProvider._load()`` rather than reading the
    blob directly: ``_load`` is what normalises v2's ``modes`` array into the
    single ``vehicle`` field and canton ids into names. Deriving the vocabulary
    any other way risks emitting mode strings the map's ``modes`` filter can
    never match.
    """
    from .boarding_data import BoardingDataProvider

    modes_by_canton: dict[str, set] = defaultdict(set)
    for line in BoardingDataProvider()._load():
        mode = line.get("vehicle")
        if not mode:
            continue
        for cname in line.get("cantons") or []:
            modes_by_canton[cname].add(mode)
    return {k: sorted(v) for k, v in modes_by_canton.items()}


def transit_modes() -> dict:
    """``{canton_name: [mode, ...]}`` for the line mode filter.

    Prefers the full bundle when it happens to be built already (free — the
    prewarm thread or an earlier stops request got there first); otherwise takes
    the light modes-only path instead of forcing a full build. Both produce the
    identical mapping; they only differ in how much unrelated work they do.
    """
    dk = dataset_key()
    bundle = _ds_cache.get(dk)
    if bundle is not None:
        return bundle["modes"]

    hit = _modes_cache.get(dk)
    if hit is not None:
        return hit

    with _modes_lock:
        hit = _modes_cache.get(dk)
        if hit is None:
            # Re-check the bundle: it may have finished while we waited.
            bundle = _ds_cache.get(dk)
            hit = bundle["modes"] if bundle is not None else _build_modes_only()
            _modes_cache[dk] = hit
        return hit


def inter_cantonal_stops() -> dict:
    """All transit stations across every canton in one FeatureCollection, each
    feature tagged with ``assigned_canton`` (its canton name). The frontend uses
    this to discover which cantons a line touches and to render the stops of a
    cross-canton line.

    Rung two of the ladder. This one genuinely needs every zone, so it does pay
    the whole-dataset coord scan — but it is requested on *line selection*
    (`useTransitLines.loadRoutes`), not on opening a zone, so it is off the
    first-paint path. Resolving unpruned is deliberate: at this point we want
    every link anyway, and the two-step pruning of :func:`_resolve_coords` would
    just enumerate every zone before doing the same work.

    Whatever `stops_by_canton` already resolved is reused, and the per-zone
    FeatureCollections it built are filled in for the zones still missing, so
    reaching this rung also completes rung one for free."""
    b = _bundle()
    if b["inter"] is not None:
        return b["inter"]
    # Its own key, so this long build blocks only other `inter` callers — never
    # the per-zone requests a user is making while the warm thread runs it.
    with _lock_for(f"{dataset_key()}|inter"):
        if b["inter"] is None:
            if not b["all_coords"]:
                _fill_coords(
                    b,
                    {
                        lk
                        for stations in b["by_zone"].values()
                        for st in stations.values()
                        for lk in st["linkids"]
                    },
                    prune=False,
                )
                b["all_coords"] = True
            reg = get_registry()
            feats = []
            for cid, stations in b["by_zone"].items():
                fc = b["fc"].get(cid)
                if fc is None:
                    fc = b["fc"][cid] = {
                        "type": "FeatureCollection",
                        "features": [
                            f
                            for f in (_feature(st, b["coords"]) for st in stations.values())
                            if f
                        ],
                    }
                cname = reg.zone_name(cid)
                for f in fc["features"]:
                    feats.append({
                        **f,
                        "properties": {**f["properties"], "assigned_canton": cname},
                    })
            b["inter"] = {"type": "FeatureCollection", "features": feats}
    return b["inter"]

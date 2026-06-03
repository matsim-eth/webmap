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
from collections import defaultdict

from .connection import get_source_cursor
from .constants import canton_name
from .paths import dataset_key

# Leading numeric token = physical station id (platforms share it), e.g.
# "8593773:0:1.link:pt_8593773:0:1" and "8593773:0:2.link:..." → station 8593773.
_STATION_RE = re.compile(r"^(\d+)")

# dataset_key → {"stops": {canton_id: FeatureCollection}, "modes": {...},
#                "inter": FeatureCollection|None}. Keyed per dataset so a worker
# serving several datasets never mixes one dataset's stops into another.
_ds_cache: dict[str, dict] = {}


def _linkid(stop_id: str) -> str | None:
    """The network link id embedded after '.link:' in a stop_id."""
    if not stop_id or ".link:" not in stop_id:
        return None
    return stop_id.split(".link:", 1)[1]


def _resolve_coords(cur, linkids: list[str]) -> dict[str, tuple]:
    """link_id → (lon, lat) via the link's to_node geometry (EPSG:2056→4326)."""
    out: dict[str, tuple] = {}
    chunk = 800
    for i in range(0, len(linkids), chunk):
        part = linkids[i : i + chunk]
        ph = ",".join(["?"] * len(part))
        rows = cur.execute(
            f"""
            SELECT l.link_id,
                   ST_X(ST_Transform(n.geom, 'EPSG:2056', 'EPSG:4326', always_xy := true)),
                   ST_Y(ST_Transform(n.geom, 'EPSG:2056', 'EPSG:4326', always_xy := true))
            FROM network_links l
            JOIN network_nodes n ON n.node_id = l.to_node
            WHERE l.link_id IN ({ph})
            """,
            part,
        ).fetchall()
        for lid, x, y in rows:
            if x is not None and y is not None:
                out[lid] = (x, y)
    return out


def _build() -> dict:
    """Single pass over boarding_data: aggregate platforms into stations per
    canton, resolve coordinates, and return a per-dataset bundle
    ``{"stops": {cid: FeatureCollection}, "modes": {...}, "inter": None}``."""
    from .boarding_data import BoardingDataProvider

    lines = BoardingDataProvider()._load()

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
            if sid not in station["stop_ids"]:
                station["stop_ids"].append(sid)
                lk = _linkid(sid)
                if lk:
                    station["linkids"].append(lk)
            if lid not in station["lines"]:
                station["lines"][lid] = {
                    "line_id": lid,
                    "line_name": lname,
                    "mode": mode,
                    "route_id": lid,
                }
            if mode:
                station["modes"].add(mode)

    # Resolve all stop coordinates in one go.
    cur = get_source_cursor("synthetic")
    all_links = list(
        {lk for cmap in by_canton.values() for st in cmap.values() for lk in st["linkids"]}
    )
    coords = _resolve_coords(cur, all_links)

    stops_by_cid: dict[int, dict] = {}
    for cid, cmap in by_canton.items():
        features = []
        for st in cmap.values():
            pts = [coords[lk] for lk in st["linkids"] if lk in coords]
            if not pts:
                # No geometry → would crash handleSelectStop (reads
                # geometry.coordinates); skip from the searchable set. Its
                # boardings still count in the canton-wide per_canton_counts.
                continue
            lon = sum(p[0] for p in pts) / len(pts)
            lat = sum(p[1] for p in pts) / len(pts)
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "name": st["name"],
                    "stop_id": st["stop_ids"],
                    "lines": list(st["lines"].values()),
                    "modes_list": sorted(st["modes"]),
                },
            })
        stops_by_cid[cid] = {"type": "FeatureCollection", "features": features}

    return {
        "stops": stops_by_cid,
        "modes": {k: sorted(v) for k, v in modes_by_canton.items()},
        "inter": None,
    }


def _bundle() -> dict:
    """Return (building if needed) the cached bundle for the current dataset."""
    dk = dataset_key()
    b = _ds_cache.get(dk)
    if b is None:
        b = _ds_cache[dk] = _build()
    return b


def stops_by_canton(canton_id: int) -> dict:
    """GeoJSON FeatureCollection of transit stations in *canton_id*."""
    return _bundle()["stops"].get(canton_id, {"type": "FeatureCollection", "features": []})


def transit_modes() -> dict:
    """``{canton_name: [mode, ...]}`` for the line mode filter."""
    return _bundle()["modes"]


def inter_cantonal_stops() -> dict:
    """All transit stations across every canton in one FeatureCollection, each
    feature tagged with ``assigned_canton`` (its canton name). The frontend uses
    this to discover which cantons a line touches and to render the stops of a
    cross-canton line."""
    b = _bundle()
    if b["inter"] is not None:
        return b["inter"]
    feats = []
    for cid, fc in b["stops"].items():
        cname = canton_name(cid)
        for f in fc["features"]:
            feats.append({
                **f,
                "properties": {**f["properties"], "assigned_canton": cname},
            })
    b["inter"] = {"type": "FeatureCollection", "features": feats}
    return b["inter"]

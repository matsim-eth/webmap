"""Build a stop_id → municipality lookup for the dashboard.

For each zone (Swiss canton by default), get the stops GeoJSON, spatially join
each stop point against the municipality polygons, and emit a flat lookup keyed
by stop_id.

Output shape:
    {
      "stop_id_a": {"bfs_nummer": 131, "municipality": "Adliswil", "kanton": "Zurich"},
      "stop_id_b": {...},
      ...
    }

Stops outside every polygon are skipped (rare — usually only stops just
outside the study-area border or floating-point edge cases).

Stop source
-----------
By default the per-canton stops files are fetched from the GitHub CDN (the
historical Swiss workflow). Pass ``stops_duckdb`` (CLI ``--stops-duckdb``) to
instead reconstruct the stops straight from a dataset's ``synthetic.duckdb``
(the ``boarding_data_by_line`` static asset + ``network_links`` → ``network_nodes``
geometry, exactly as webmap-backend/providers/transit_stops.py does). That path
needs no network and works for any study area; the CDN path is kept only as the
Swiss default so existing commands are byte-identical.
"""

from __future__ import annotations

import json
import re
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

from shapely.geometry import shape, Point
from shapely.strtree import STRtree


CANTONS = [
    "Aargau", "AppenzellAusserrhoden", "AppenzellInnerrhoden",
    "Basel-Landschaft", "Basel-Stadt", "Bern", "Fribourg", "Geneve",
    "Glarus", "Graubunden", "Jura", "Luzern", "Neuchatel", "Nidwalden",
    "Obwalden", "Schaffhausen", "Schwyz", "Solothurn", "StGallen",
    "Ticino", "Thurgau", "Uri", "Valais", "Vaud", "Zug", "Zurich",
]

CDN_BASE = "https://matsim-eth.github.io/webmap/data/matsim/transit/stops_by_canton"

# Leading numeric token = physical station id (platforms share it) — mirrors
# providers/transit_stops.py so duckdb-reconstructed stations match the CDN's.
_STATION_RE = re.compile(r"^(\d+)")


def _fetch_canton_stops(canton: str) -> dict[str, Any] | None:
    url = f"{CDN_BASE}/{canton}_stops.geojson"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"  [{canton}] fetch failed: {exc}")
        return None


def _normalize_stop_ids(raw) -> list[str]:
    """A stop feature may carry a single stop_id or an array (one feature per
    cluster of stops sharing a name). Always return a flat list of strings.
    """
    if isinstance(raw, list):
        out: list[str] = []
        for item in raw:
            out.extend(_normalize_stop_ids(item))
        return out
    if isinstance(raw, str):
        # JSON-encoded list?
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return _normalize_stop_ids(parsed)
        except (json.JSONDecodeError, ValueError):
            pass
        return [raw]
    if raw is None:
        return []
    return [str(raw)]


# ─── DuckDB stop reconstruction (CDN-free; mirrors transit_stops.py) ─────────

def _linkid(stop_id: str) -> str | None:
    if not stop_id or ".link:" not in stop_id:
        return None
    return stop_id.split(".link:", 1)[1]


def _duckdb_asset(con, key: str):
    row = con.execute(
        "SELECT payload FROM static_assets WHERE key = ?", [key]
    ).fetchone()
    return json.loads(bytes(row[0])) if row and row[0] is not None else None


def _zone_names(con, primary_type: str) -> dict[int, str]:
    """{zone_id: name} from the primary-type rows of hot_polygons."""
    out: dict[int, str] = {}
    try:
        rows = con.execute(
            "SELECT polygon_id, polygon_name FROM hot_polygons WHERE polygon_type = ?",
            [primary_type],
        ).fetchall()
    except Exception:  # noqa: BLE001
        return out
    for pid, name in rows:
        try:
            out[int(str(pid).split(":", 1)[1])] = name or str(pid)
        except (ValueError, IndexError):
            continue
    return out


def _stops_from_duckdb(duckdb_path: Path) -> Iterable[tuple[str, list[dict]]]:
    """Yield ``(zone_name, [stop_feature, ...])`` for every zone, reconstructed
    from the dataset's own duckdb — no CDN. Each stop feature has a Point
    geometry and a ``properties.stop_id`` list, matching the CDN's shape."""
    import duckdb

    con = duckdb.connect(str(duckdb_path), read_only=True)
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        meta = _duckdb_asset(con, "study_area") or {}
        crs = meta.get("crs") or "EPSG:2056"
        primary_type = meta.get("primary_zone_type") or "canton"
        zone_names = _zone_names(con, primary_type)

        lines = _duckdb_asset(con, "boarding_data_by_line") or []

        # canton_id -> station_key -> station dict
        by_zone: dict[int, dict[str, dict]] = defaultdict(dict)
        for line in lines:
            for s in line.get("stops", []):
                cid = s.get("canton_id")
                sid = s.get("stop_id")
                if cid is None or not sid:
                    continue
                m = _STATION_RE.match(sid)
                skey = m.group(1) if m else sid
                station = by_zone[cid].get(skey)
                if station is None:
                    station = by_zone[cid][skey] = {
                        "name": s.get("name"), "stop_ids": [], "linkids": [],
                    }
                if sid not in station["stop_ids"]:
                    station["stop_ids"].append(sid)
                    lk = _linkid(sid)
                    if lk:
                        station["linkids"].append(lk)

        # Resolve link_id -> (lon, lat) via the stop link's to_node geometry.
        all_links = list(
            {lk for zmap in by_zone.values() for st in zmap.values() for lk in st["linkids"]}
        )
        coords: dict[str, tuple] = {}
        if all_links:
            rows = con.execute(
                f"""
                SELECT l.link_id,
                       ST_X(ST_Transform(n.geom, '{crs}', 'EPSG:4326', always_xy := true)),
                       ST_Y(ST_Transform(n.geom, '{crs}', 'EPSG:4326', always_xy := true))
                FROM network_links l
                JOIN network_nodes n ON n.node_id = l.to_node
                WHERE l.link_id IN (SELECT UNNEST(?))
                """,
                [all_links],
            ).fetchall()
            coords = {lid: (x, y) for lid, x, y in rows if x is not None and y is not None}

        for cid, zmap in by_zone.items():
            feats = []
            for st in zmap.values():
                pts = [coords[lk] for lk in st["linkids"] if lk in coords]
                if not pts:
                    continue
                lon = sum(p[0] for p in pts) / len(pts)
                lat = sum(p[1] for p in pts) / len(pts)
                feats.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {"name": st["name"], "stop_id": st["stop_ids"]},
                })
            yield zone_names.get(cid, str(cid)), feats
    finally:
        con.close()


def _iter_stop_sources(stops_duckdb: Path | None) -> Iterable[tuple[str, list[dict]]]:
    """Yield ``(kanton_name, features)`` from either the duckdb or the CDN."""
    if stops_duckdb is not None:
        yield from _stops_from_duckdb(stops_duckdb)
        return
    for canton in CANTONS:
        stops = _fetch_canton_stops(canton)
        if not stops:
            continue
        yield canton, stops.get("features") or []


def build_stop_municipality(
    municipalities_path: Path,
    output_path: Path,
    stops_duckdb: Path | None = None,
) -> None:
    with open(municipalities_path, "r", encoding="utf-8") as f:
        muni_geo = json.load(f)

    polygons = []
    polygon_props = []
    for feat in muni_geo["features"]:
        try:
            geom = shape(feat["geometry"])
        except Exception:  # noqa: BLE001
            continue
        if geom.is_empty:
            continue
        polygons.append(geom)
        polygon_props.append(feat["properties"])

    tree = STRtree(polygons)
    print(f"Indexed {len(polygons)} municipality polygons.")

    lookup: dict[str, dict[str, Any]] = {}
    total_stops = 0
    matched = 0

    for kanton, feats in _iter_stop_sources(stops_duckdb):
        print(f"  [{kanton}] {len(feats)} stop features")

        for feat in feats:
            geom = feat.get("geometry") or {}
            if geom.get("type") != "Point":
                continue
            x, y = geom["coordinates"][0], geom["coordinates"][1]
            point = Point(x, y)

            candidate_idxs = tree.query(point)
            chosen_props = None
            for idx in candidate_idxs:
                if polygons[idx].contains(point):
                    chosen_props = polygon_props[idx]
                    break

            stop_ids = _normalize_stop_ids(feat.get("properties", {}).get("stop_id"))
            for sid in stop_ids:
                total_stops += 1
                if chosen_props is None:
                    continue
                lookup[sid] = {
                    "bfs_nummer": chosen_props.get("bfs_nummer"),
                    "municipality": chosen_props.get("name"),
                    "kanton": kanton,
                }
                matched += 1

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(lookup, f, separators=(",", ":"), ensure_ascii=False)

    print(
        f"Wrote {len(lookup)} stop_id entries (matched {matched}/{total_stops}) "
        f"to {output_path}"
    )

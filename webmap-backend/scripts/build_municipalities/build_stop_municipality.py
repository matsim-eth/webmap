"""Build a stop_id → municipality lookup for the dashboard.

For each Swiss canton, fetch the stops GeoJSON (from the GitHub CDN),
spatially join each stop point against the municipalities polygons, and
emit a flat lookup keyed by stop_id.

Output shape:
    {
      "stop_id_a": {"bfs_nummer": 131, "municipality": "Adliswil", "kanton": "Zurich"},
      "stop_id_b": {...},
      ...
    }

Stops outside every polygon are skipped (rare — usually only stops just
outside the Swiss border or floating-point edge cases).
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Any

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


def build_stop_municipality(
    municipalities_path: Path,
    output_path: Path,
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

    for canton in CANTONS:
        stops = _fetch_canton_stops(canton)
        if not stops:
            continue
        feats = stops.get("features") or []
        print(f"  [{canton}] {len(feats)} stop features")

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
                    "kanton": canton,
                }
                matched += 1

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(lookup, f, separators=(",", ":"), ensure_ascii=False)

    print(
        f"Wrote {len(lookup)} stop_id entries (matched {matched}/{total_stops}) "
        f"to {output_path}"
    )

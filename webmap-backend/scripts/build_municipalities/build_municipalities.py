"""Reproject + simplify Swiss municipality polygons (TLM_HOHEITSGEBIET) for the dashboard.

The source file is published by swisstopo in EPSG:2056 (Swiss LV95). Mapbox /
turf.js need WGS84 (EPSG:4326). The raw file is also too large to ship
unmodified (~50 MB, 2136 polygons with full vertex resolution).

Pipeline
--------
  1. Read source GeoJSON.
  2. Reproject every coordinate from LV95 → WGS84 with pyproj.
  3. Simplify each polygon with shapely (default tolerance ≈10 m, applied in
     LV95 metres BEFORE reprojection so the tolerance is a real distance).
  4. Keep only NAME, BFS_NUMMER, KANTONSNUM in properties; drop UUID/dates.
  5. Write a compact GeoJSON.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform as shapely_transform


_LV95_TO_WGS84 = Transformer.from_crs("EPSG:2056", "EPSG:4326", always_xy=True)


def _reproject(geom):
    return shapely_transform(_LV95_TO_WGS84.transform, geom)


def build_municipalities(
    input_path: Path,
    output_path: Path,
    simplify_tolerance_m: float = 10.0,
) -> None:
    with open(input_path, "r", encoding="utf-8") as f:
        src = json.load(f)

    out_features: list[dict[str, Any]] = []
    skipped = 0

    for feat in src.get("features", []):
        geom_dict = feat.get("geometry")
        props = feat.get("properties") or {}
        if not geom_dict:
            skipped += 1
            continue

        try:
            geom = shape(geom_dict)
        except Exception:
            skipped += 1
            continue

        if simplify_tolerance_m > 0:
            geom = geom.simplify(simplify_tolerance_m, preserve_topology=True)

        if geom.is_empty:
            skipped += 1
            continue

        geom = _reproject(geom)

        out_features.append({
            "type": "Feature",
            "geometry": mapping(geom),
            "properties": {
                "name": props.get("NAME"),
                "bfs_nummer": props.get("BFS_NUMMER"),
                "kantonsnum": props.get("KANTONSNUM"),
            },
        })

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(
            {"type": "FeatureCollection", "features": out_features},
            f,
            separators=(",", ":"),
            ensure_ascii=False,
        )

    print(f"Wrote {len(out_features)} features (skipped {skipped}) to {output_path}")

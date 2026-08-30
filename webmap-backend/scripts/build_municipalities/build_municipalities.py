"""Reproject + simplify municipality (zone) polygons for the dashboard.

Historically the source is swisstopo's TLM_HOHEITSGEBIET in EPSG:2056 (Swiss
LV95). Mapbox / turf.js need WGS84 (EPSG:4326), and the raw file is too large
to ship unmodified (~50 MB, 2136 polygons with full vertex resolution).

The source CRS and the property names to carry across are parametrised (with
Swiss defaults), so any study area's admin-unit polygons can be processed.
Example for a non-Swiss area whose GeoJSON is already WGS84 with lowercase
properties::

    build_municipalities(src, out, crs="EPSG:4326",
                         name_property="commune", id_property="insee",
                         parent_property="dept")

Pipeline
--------
  1. Read source GeoJSON.
  2. Reproject every coordinate from ``crs`` → WGS84 with pyproj (a no-op when
     ``crs`` is already EPSG:4326).
  3. Simplify each polygon with shapely (default tolerance ≈10 m, applied in
     the source CRS's units BEFORE reprojection so the tolerance is a real
     distance for projected CRSs).
  4. Keep only the id/name/parent properties; drop UUID/dates.
  5. Write a compact GeoJSON.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform as shapely_transform


def build_municipalities(
    input_path: Path,
    output_path: Path,
    simplify_tolerance_m: float = 10.0,
    crs: str = "EPSG:2056",
    name_property: str = "NAME",
    id_property: str = "BFS_NUMMER",
    parent_property: str = "KANTONSNUM",
) -> None:
    """Reproject + simplify zone polygons.

    Parameters
    ----------
    input_path           : source GeoJSON of zone (municipality) polygons
    output_path          : compact WGS84 GeoJSON to write
    simplify_tolerance_m : shapely simplify tolerance in the source CRS units
                           (default 10.0). Set 0 to skip simplification.
    crs                  : source CRS (default ``EPSG:2056`` = Swiss LV95)
    name_property        : GeoJSON property with the zone name → output ``name``
                           (default ``NAME``)
    id_property          : GeoJSON property with the zone id → output
                           ``bfs_nummer`` (default ``BFS_NUMMER``)
    parent_property      : GeoJSON property with the parent (canton) id → output
                           ``kantonsnum`` (default ``KANTONSNUM``)
    """
    transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    def _reproject(geom):
        return shapely_transform(transformer.transform, geom)

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
                "name": props.get(name_property),
                "bfs_nummer": props.get(id_property),
                "kantonsnum": props.get(parent_property),
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

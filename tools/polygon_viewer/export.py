"""Export hot_polygons from a v1 synthetic.duckdb to per-type GeoJSON files.

Run from the project root:

    .venv-test/bin/python tools/polygon_viewer/export.py \\
        data/dataset-storage/public/1/synthetic.duckdb \\
        tools/polygon_viewer/data/

Produces:
    cantons.geojson    (26 features, ~5MB)
    bezirke.geojson    (134 features)
    gemeinden.geojson  (2162 features)

Geometries are reprojected from EPSG:2056 (LV95) to EPSG:4326 (WGS84) so
Leaflet can render them directly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb


def export(db_path: str, out_dir: str) -> None:
    db = Path(db_path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    if not db.exists():
        sys.exit(f"DB not found: {db}")

    con = duckdb.connect(str(db), read_only=True)
    con.execute("LOAD spatial;")

    types = [r[0] for r in con.execute(
        "SELECT DISTINCT polygon_type FROM hot_polygons ORDER BY 1"
    ).fetchall()]

    # Simplification tolerance per type (in degrees, since we transform first)
    # Bigger polygons can lose more detail without visible difference at typical
    # zoom levels. Cantons get the most aggressive simplification, gemeinden
    # the gentlest (they're already small).
    tolerance = {"canton": 0.001, "bezirk": 0.0005, "gemeinde": 0.0002}

    for ptype in types:
        tol = tolerance.get(ptype, 0.0005)
        rows = con.execute(f"""
            SELECT polygon_id, polygon_name, parent_id,
                   ST_AsGeoJSON(
                       ST_Simplify(
                           ST_Transform(polygon_geom, 'EPSG:2056', 'EPSG:4326', always_xy := true),
                           {tol}
                       )
                   )
            FROM hot_polygons WHERE polygon_type = ?
            ORDER BY polygon_id
        """, [ptype]).fetchall()

        features = []
        for pid, name, parent, geom_json in rows:
            try:
                geom = json.loads(geom_json) if isinstance(geom_json, str) else geom_json
            except Exception:
                continue
            features.append({
                "type": "Feature",
                "properties": {
                    "polygon_id": pid,
                    "polygon_type": ptype,
                    "polygon_name": name,
                    "parent_id": parent,
                },
                "geometry": geom,
            })

        out_file = out / f"{ptype}s.geojson"  # cantons / bezirks / gemeindes — but legacy uses cantons
        # use the canonical file names
        canonical = {"canton": "cantons.geojson",
                     "bezirk": "bezirke.geojson",
                     "gemeinde": "gemeinden.geojson"}
        if ptype in canonical:
            out_file = out / canonical[ptype]

        with open(out_file, "w") as f:
            json.dump({"type": "FeatureCollection", "features": features}, f)
        size_mb = out_file.stat().st_size / 1e6
        print(f"  {out_file.name}: {len(features)} features, {size_mb:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(f"usage: {sys.argv[0]} <synthetic.duckdb> <out_dir>")
    export(sys.argv[1], sys.argv[2])

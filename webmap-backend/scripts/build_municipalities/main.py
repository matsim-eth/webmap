#!/usr/bin/env python3
"""Manual trigger for building municipalities.geojson + stop_municipality.json.

Usage
-----
    # Swiss default — unchanged from before:
    python main.py            # both steps
    python main.py muni       # just the polygon reproject/simplify
    python main.py stops      # just the stop -> municipality lookup

    # Any other study area (reproject a non-Swiss admin-unit GeoJSON and build
    # the stop lookup straight from a dataset's synthetic.duckdb, no CDN):
    python main.py all --zones vaud_muni.geojson --crs EPSG:2056 \
        --zone-name-property NAME --zone-id-property BFS_NUMMER \
        --stops-duckdb /path/to/synthetic.duckdb

The ``mode`` positional and default paths are unchanged; the new flags default
to the Swiss setup so no-flag invocations behave exactly as before. Without
``--stops-duckdb`` the stops step still fetches per-canton files from the CDN
(the historical Swiss path).
"""

import argparse
import sys
from pathlib import Path

from build_municipalities import build_municipalities
from build_stop_municipality import build_stop_municipality


_PUBLIC_DATASET = Path(__file__).resolve().parents[3] / "data" / "dataset-storage" / "public" / "1"
_DEFAULT_INPUT = Path(__file__).resolve().parents[3] / "data" / "dataset-storage" / "1" / "TLM_HOHEITSGEBIET.json"
_DEFAULT_MUNI = _PUBLIC_DATASET / "json_preview" / "municipalities.geojson"
_DEFAULT_LOOKUP = _PUBLIC_DATASET / "json_preview" / "stop_municipality.json"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", nargs="?", default="all", choices=["all", "muni", "stops"],
                    help="which step(s) to run (default: all)")
    ap.add_argument("--zones", default=None,
                    help="source municipality-polygon GeoJSON "
                         "(default: the Swiss TLM_HOHEITSGEBIET.json)")
    ap.add_argument("--zone-type", default="municipality",
                    help="zone type label (informational; default: municipality)")
    ap.add_argument("--crs", default="EPSG:2056",
                    help="source CRS of the polygons (default: EPSG:2056)")
    ap.add_argument("--zone-name-property", default="NAME",
                    help="GeoJSON property with the zone name (default: NAME)")
    ap.add_argument("--zone-id-property", default="BFS_NUMMER",
                    help="GeoJSON property with the zone (BFS) id (default: BFS_NUMMER)")
    ap.add_argument("--parent-id-property", default="KANTONSNUM",
                    help="GeoJSON property with the parent canton id "
                         "(default: KANTONSNUM)")
    ap.add_argument("--tolerance", type=float, default=10.0,
                    help="simplify tolerance in source-CRS units (default: 10)")
    ap.add_argument("--stops-duckdb", default=None,
                    help="reconstruct stops from this synthetic.duckdb instead of "
                         "the CDN (CDN-free; works for any study area)")
    ap.add_argument("--output-muni", default=None,
                    help="override the municipalities.geojson output path")
    ap.add_argument("--output-lookup", default=None,
                    help="override the stop_municipality.json output path")
    args = ap.parse_args()

    muni_input = Path(args.zones) if args.zones else _DEFAULT_INPUT
    muni_out = Path(args.output_muni) if args.output_muni else _DEFAULT_MUNI
    lookup_out = Path(args.output_lookup) if args.output_lookup else _DEFAULT_LOOKUP
    stops_duckdb = Path(args.stops_duckdb) if args.stops_duckdb else None

    if args.mode in ("all", "muni"):
        if not muni_input.exists():
            print(f"Input not found: {muni_input}", file=sys.stderr)
            sys.exit(1)
        build_municipalities(
            muni_input, muni_out, simplify_tolerance_m=args.tolerance,
            crs=args.crs, name_property=args.zone_name_property,
            id_property=args.zone_id_property, parent_property=args.parent_id_property,
        )

    if args.mode in ("all", "stops"):
        if not muni_out.exists():
            print(f"Run muni step first: {muni_out} missing", file=sys.stderr)
            sys.exit(1)
        build_stop_municipality(muni_out, lookup_out, stops_duckdb=stops_duckdb)


if __name__ == "__main__":
    main()

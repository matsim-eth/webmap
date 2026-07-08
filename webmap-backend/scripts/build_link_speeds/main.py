#!/usr/bin/env python3
"""Manual trigger for building link_speeds.parquet.

Usage
-----
    # Swiss default (26 cantons, LV95 network) — unchanged from before:
    python main.py
    python main.py /path/to/output_network.xml /path/to/output_events.parquet \
        /path/to/link_speeds.parquet [/path/to/TLM_KANTONSGEBIET.geojson]

    # Any other study area (e.g. Vaud municipalities):
    python main.py net.xml events.parquet link_speeds.parquet vaud_muni.geojson \
        --zone-type municipality --zone-id-property BFS_NUMMER \
        --zone-name-property NAME --crs EPSG:2056

The four positional args (network / events / output / zones GeoJSON) keep their
historical order and defaults; the new ``--zone-*`` / ``--crs`` flags default to
the Swiss setup so no-flag invocations behave exactly as before.
"""

import argparse
from pathlib import Path

from build_link_speeds import build_link_speeds

_DATA_DIR = Path(__file__).resolve().parents[2] / "dummy_data" / "webmap_data" / "synthetic"
_JSON_DIR = Path(__file__).resolve().parents[2] / "dummy_data" / "webmap_data" / "json_preview"

_DEFAULTS = {
    "network_xml": _DATA_DIR / "output_network.xml",
    "events_parquet": _DATA_DIR / "output_events.parquet",
    "output_parquet": _DATA_DIR / "link_speeds.parquet",
    "canton_geojson": _JSON_DIR / "TLM_KANTONSGEBIET.geojson",
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("network_xml", nargs="?", default=None,
                    help="output_network.xml (with osm:way:highway)")
    ap.add_argument("events_parquet", nargs="?", default=None,
                    help="output_events.parquet")
    ap.add_argument("output_parquet", nargs="?", default=None,
                    help="path where link_speeds.parquet is written")
    ap.add_argument("zones", nargs="?", default=None,
                    help="zone boundaries GeoJSON, WGS84 (default: "
                         "TLM_KANTONSGEBIET.geojson = 26 Swiss cantons)")
    ap.add_argument("--zones", dest="zones_opt", default=None,
                    help="alias for the positional zones argument")
    ap.add_argument("--zone-type", default="canton",
                    help="zone type label (informational; the output column is "
                         "always canton_id — default: canton)")
    ap.add_argument("--zone-id-property", default="KANTONSNUMMER",
                    help="GeoJSON property with the numeric zone id "
                         "(default: KANTONSNUMMER)")
    ap.add_argument("--zone-name-property", default="NAME",
                    help="GeoJSON property with the zone name (default: NAME)")
    ap.add_argument("--crs", default="EPSG:2056",
                    help="projected CRS of the network geometry (default: EPSG:2056)")
    args = ap.parse_args()

    network_xml = Path(args.network_xml) if args.network_xml else _DEFAULTS["network_xml"]
    events_parquet = Path(args.events_parquet) if args.events_parquet else _DEFAULTS["events_parquet"]
    output_parquet = Path(args.output_parquet) if args.output_parquet else _DEFAULTS["output_parquet"]

    zones = args.zones_opt or args.zones
    canton_geojson = Path(zones) if zones else _DEFAULTS["canton_geojson"]
    if not canton_geojson.exists():
        canton_geojson = None

    build_link_speeds(
        network_xml, events_parquet,
        output_parquet, canton_geojson,
        zone_id_property=args.zone_id_property,
        zone_name_property=args.zone_name_property,
        crs=args.crs,
    )


if __name__ == "__main__":
    main()

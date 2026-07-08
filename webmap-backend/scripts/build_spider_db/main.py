#!/usr/bin/env python3
"""Manual trigger for building spider.duckdb.

Usage
-----
    # Swiss default (26 cantons, LV95 coords) — unchanged from before:
    python main.py
    python main.py /path/to/events.xml /path/to/persons.parquet \
        /path/to/households.parquet /path/to/spider.duckdb \
        [/path/to/output_trips.parquet] [/path/to/TLM_KANTONSGEBIET.geojson]

    # Any other study area (e.g. Vaud municipalities):
    python main.py events.xml persons.parquet households.parquet spider.duckdb \
        output_trips.parquet vaud_muni.geojson --zone-type municipality \
        --zone-id-property BFS_NUMMER --zone-name-property NAME --crs EPSG:2056

The positional args keep their historical order and defaults; the new
``--zone-*`` / ``--crs`` flags default to the Swiss setup so no-flag
invocations behave exactly as before.
"""

import argparse
from pathlib import Path

from build_spider_db import build_spider_db

_DATA_DIR = Path(__file__).resolve().parents[2] / "dummy_data" / "webmap_data" / "synthetic"
_JSON_DIR = Path(__file__).resolve().parents[2] / "dummy_data" / "webmap_data" / "json_preview"

_DEFAULTS = {
    "events_xml": _DATA_DIR / "output_events.xml",
    "persons_parquet": _DATA_DIR / "switzerland_persons.parquet",
    "households_parquet": _DATA_DIR / "households.parquet",
    "output_db": _DATA_DIR / "spider.duckdb",
    "output_trips_parquet": _DATA_DIR / "output_trips.parquet",
    "canton_geojson": _JSON_DIR / "TLM_KANTONSGEBIET.geojson",
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("events_xml", nargs="?", default=None)
    ap.add_argument("persons_parquet", nargs="?", default=None)
    ap.add_argument("households_parquet", nargs="?", default=None)
    ap.add_argument("output_db", nargs="?", default=None)
    ap.add_argument("output_trips_parquet", nargs="?", default=None)
    ap.add_argument("zones", nargs="?", default=None,
                    help="zone boundaries GeoJSON, WGS84 (default: "
                         "TLM_KANTONSGEBIET.geojson = 26 Swiss cantons)")
    ap.add_argument("--zones", dest="zones_opt", default=None,
                    help="alias for the positional zones argument")
    ap.add_argument("--zone-type", default="canton",
                    help="zone type label (informational; the output columns are "
                         "always origin_canton_id / dest_canton_id — default: canton)")
    ap.add_argument("--zone-id-property", default="KANTONSNUMMER",
                    help="GeoJSON property with the numeric zone id "
                         "(default: KANTONSNUMMER)")
    ap.add_argument("--zone-name-property", default="NAME",
                    help="GeoJSON property with the zone name (default: NAME)")
    ap.add_argument("--crs", default="EPSG:2056",
                    help="projected CRS of trip start/end coords (default: EPSG:2056)")
    args = ap.parse_args()

    events_xml = Path(args.events_xml) if args.events_xml else _DEFAULTS["events_xml"]
    persons_parquet = Path(args.persons_parquet) if args.persons_parquet else _DEFAULTS["persons_parquet"]
    households_parquet = Path(args.households_parquet) if args.households_parquet else _DEFAULTS["households_parquet"]
    output_db = Path(args.output_db) if args.output_db else _DEFAULTS["output_db"]
    output_trips_parquet = (Path(args.output_trips_parquet)
                            if args.output_trips_parquet else _DEFAULTS["output_trips_parquet"])

    zones = args.zones_opt or args.zones
    canton_geojson = Path(zones) if zones else _DEFAULTS["canton_geojson"]

    # If output_trips doesn't exist, pass None (optional)
    if not output_trips_parquet.exists():
        output_trips_parquet = None

    # If zones geojson doesn't exist, pass None (optional)
    if not canton_geojson.exists():
        canton_geojson = None

    build_spider_db(
        events_xml, persons_parquet, households_parquet,
        output_db, output_trips_parquet, canton_geojson,
        zone_id_property=args.zone_id_property,
        zone_name_property=args.zone_name_property,
        crs=args.crs,
    )


if __name__ == "__main__":
    main()

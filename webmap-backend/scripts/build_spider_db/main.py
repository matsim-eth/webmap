#!/usr/bin/env python3
"""Manual trigger for building spider.duckdb.

Usage
-----
    python main.py
    python main.py /path/to/events.xml /path/to/persons.parquet /path/to/households.parquet /path/to/spider.duckdb [/path/to/output_trips.parquet] [/path/to/TLM_KANTONSGEBIET.geojson]
"""

import sys
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
    args = sys.argv[1:]
    events_xml = Path(args[0]) if len(args) > 0 else _DEFAULTS["events_xml"]
    persons_parquet = Path(args[1]) if len(args) > 1 else _DEFAULTS["persons_parquet"]
    households_parquet = Path(args[2]) if len(args) > 2 else _DEFAULTS["households_parquet"]
    output_db = Path(args[3]) if len(args) > 3 else _DEFAULTS["output_db"]
    output_trips_parquet = Path(args[4]) if len(args) > 4 else _DEFAULTS["output_trips_parquet"]
    canton_geojson = Path(args[5]) if len(args) > 5 else _DEFAULTS["canton_geojson"]

    # If output_trips doesn't exist, pass None (optional)
    if not output_trips_parquet.exists():
        output_trips_parquet = None

    # If canton geojson doesn't exist, pass None (optional)
    if not canton_geojson.exists():
        canton_geojson = None

    build_spider_db(
        events_xml, persons_parquet, households_parquet,
        output_db, output_trips_parquet, canton_geojson,
    )


if __name__ == "__main__":
    main()

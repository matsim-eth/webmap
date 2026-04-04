#!/usr/bin/env python3
"""Manual trigger for building link_speeds.parquet.

Usage
-----
    python main.py
    python main.py /path/to/output_network.xml /path/to/output_events.parquet /path/to/link_speeds.parquet [/path/to/TLM_KANTONSGEBIET.geojson]
"""

import sys
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
    args = sys.argv[1:]
    network_xml = Path(args[0]) if len(args) > 0 else _DEFAULTS["network_xml"]
    events_parquet = Path(args[1]) if len(args) > 1 else _DEFAULTS["events_parquet"]
    output_parquet = Path(args[2]) if len(args) > 2 else _DEFAULTS["output_parquet"]
    canton_geojson = Path(args[3]) if len(args) > 3 else _DEFAULTS["canton_geojson"]

    if not canton_geojson.exists():
        canton_geojson = None

    build_link_speeds(
        network_xml, events_parquet,
        output_parquet, canton_geojson,
    )


if __name__ == "__main__":
    main()

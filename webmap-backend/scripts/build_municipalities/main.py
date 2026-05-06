#!/usr/bin/env python3
"""Manual trigger for building municipalities.geojson.

Usage
-----
    python main.py
    python main.py /path/to/TLM_HOHEITSGEBIET.json /path/to/municipalities.geojson [tolerance_m]
"""

import sys
from pathlib import Path

from build_municipalities import build_municipalities
from build_stop_municipality import build_stop_municipality


_PUBLIC_DATASET = Path(__file__).resolve().parents[3] / "data" / "dataset-storage" / "public" / "1"
_DEFAULT_INPUT = Path(__file__).resolve().parents[3] / "data" / "dataset-storage" / "1" / "TLM_HOHEITSGEBIET.json"
_DEFAULT_MUNI = _PUBLIC_DATASET / "json_preview" / "municipalities.geojson"
_DEFAULT_LOOKUP = _PUBLIC_DATASET / "json_preview" / "stop_municipality.json"


def main() -> None:
    args = sys.argv[1:]
    mode = args[0] if args else "all"

    if mode in ("all", "muni"):
        if not _DEFAULT_INPUT.exists():
            print(f"Input not found: {_DEFAULT_INPUT}", file=sys.stderr)
            sys.exit(1)
        build_municipalities(_DEFAULT_INPUT, _DEFAULT_MUNI, simplify_tolerance_m=10.0)

    if mode in ("all", "stops"):
        if not _DEFAULT_MUNI.exists():
            print(f"Run muni step first: {_DEFAULT_MUNI} missing", file=sys.stderr)
            sys.exit(1)
        build_stop_municipality(_DEFAULT_MUNI, _DEFAULT_LOOKUP)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Manual trigger for rewriting `cantons` on boarding_data_by_line.json.

Usage
-----
    # Swiss default (local per-canton stops mirror, else CDN) — unchanged:
    python main.py
    python main.py /path/to/boarding_data_by_line.json /path/to/output.json
    python main.py <in> <out> /path/to/local/stops_by_canton

    # Any study area — derive the zone set straight from the dataset duckdb
    # (no CDN, no per-canton stops files):
    python main.py <in> <out> --stops-duckdb /path/to/synthetic.duckdb

The positional args keep their historical order and defaults; ``--stops-duckdb``
switches the zone-membership source to the dataset's own duckdb. Without it the
Swiss local-mirror/CDN path is used, byte-identical to before.
"""

import argparse
from pathlib import Path

from build_line_cantons import build_line_cantons


_PUBLIC_DATASET = Path(__file__).resolve().parents[3] / "data" / "dataset-storage" / "public" / "1"
_DEFAULT_BOARDING = _PUBLIC_DATASET / "json_preview" / "boarding_data_by_line.json"
# dist/data has a local mirror of the per-canton stops files; prefer it when
# available so the script works without network.
_DEFAULT_LOCAL_STOPS = (
    Path(__file__).resolve().parents[3]
    / "dist" / "data" / "matsim" / "transit" / "stops_by_canton"
)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("boarding_in", nargs="?", default=None,
                    help="input boarding_data_by_line.json")
    ap.add_argument("boarding_out", nargs="?", default=None,
                    help="output path (default: overwrite the input)")
    ap.add_argument("local_stops", nargs="?", default=None,
                    help="directory of per-canton {canton}_stops.geojson files "
                         "(default: the dist/ local mirror if present, else CDN)")
    ap.add_argument("--stops-duckdb", default=None,
                    help="derive the line-to-zone map from this synthetic.duckdb "
                         "instead of per-canton stops files (CDN-free)")
    args = ap.parse_args()

    boarding_in = Path(args.boarding_in) if args.boarding_in else _DEFAULT_BOARDING
    boarding_out = Path(args.boarding_out) if args.boarding_out else boarding_in
    stops_duckdb = Path(args.stops_duckdb) if args.stops_duckdb else None

    if args.local_stops:
        local_stops = Path(args.local_stops)
    elif _DEFAULT_LOCAL_STOPS.exists():
        local_stops = _DEFAULT_LOCAL_STOPS
    else:
        local_stops = None

    if not boarding_in.exists():
        print(f"Input not found: {boarding_in}", file=__import__("sys").stderr)
        raise SystemExit(1)

    print(f"Reading  {boarding_in}")
    print(f"Writing  {boarding_out}")
    if stops_duckdb is not None:
        print(f"Stops    {stops_duckdb} (duckdb)")
    else:
        print(f"Stops    {local_stops or '(CDN)'}")
    build_line_cantons(boarding_in, boarding_out, local_stops, stops_duckdb=stops_duckdb)


if __name__ == "__main__":
    main()

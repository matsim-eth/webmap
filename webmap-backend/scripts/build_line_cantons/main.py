#!/usr/bin/env python3
"""Manual trigger for rewriting `cantons` on boarding_data_by_line.json.

Usage
-----
    python main.py
    python main.py /path/to/boarding_data_by_line.json /path/to/output.json
    python main.py <in> <out> /path/to/local/stops_by_canton
"""

import sys
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
    args = sys.argv[1:]
    boarding_in = Path(args[0]) if len(args) >= 1 else _DEFAULT_BOARDING
    boarding_out = Path(args[1]) if len(args) >= 2 else boarding_in
    local_stops = (
        Path(args[2]) if len(args) >= 3
        else (_DEFAULT_LOCAL_STOPS if _DEFAULT_LOCAL_STOPS.exists() else None)
    )

    if not boarding_in.exists():
        print(f"Input not found: {boarding_in}", file=sys.stderr)
        sys.exit(1)

    print(f"Reading  {boarding_in}")
    print(f"Writing  {boarding_out}")
    print(f"Stops    {local_stops or '(CDN)'}")
    build_line_cantons(boarding_in, boarding_out, local_stops)


if __name__ == "__main__":
    main()

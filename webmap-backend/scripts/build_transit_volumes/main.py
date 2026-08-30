"""CLI: add PT passenger link volumes to an existing synthetic.duckdb.

  python main.py --events /path/output_events.xml[.gz] --db /path/synthetic.duckdb
"""

import argparse

from build_transit_volumes import build_transit_volumes


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--events", required=True,
                   help="MATSim output_events.xml (or .xml.gz)")
    p.add_argument("--db", required=True,
                   help="synthetic.duckdb to extend (modified in place)")
    p.add_argument("--memory-limit", default="8GB")
    args = p.parse_args()
    build_transit_volumes(args.events, args.db, args.memory_limit)


if __name__ == "__main__":
    main()

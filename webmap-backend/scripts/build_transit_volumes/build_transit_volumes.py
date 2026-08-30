"""Add PT passenger link volumes to an existing synthetic.duckdb.

Fills the data gap behind the webmap's "Transit Volumes" module: passenger
volumes per network link, per transit line, in 15-minute bins — previously
only available as a stale precomputed asset on the GitHub CDN.

Pipeline (retrofit — runs against an ALREADY BUILT synthetic.duckdb):
  1. SAX-stream output_events.xml:
       TransitDriverStarts        → vehicle → transit line (+ driver id)
       PersonEnters/LeavesVehicle → per-vehicle passenger occupancy
       entered link               → accumulate (link, line, 15-min bin) += occupancy
  2. Write table `pt_link_volumes(link_id, line_id, time_bin, volume)`
     (raw sample counts — population scaling happens at serving time).
  3. Backfill network_links.canton_id for pt_* links (spatial join against
     the canton polygons in hot_polygons) so per-canton slicing works.

Usage
-----
  python main.py --events output_events.xml --db synthetic.duckdb
"""

from __future__ import annotations

import gzip
import xml.sax
import xml.sax.handler
from collections import defaultdict
from pathlib import Path

import duckdb

FLUSH_KEYS = 4_000_000     # accumulated (link, line, bin) cells before a DB flush
BIN_SECONDS = 900          # 15-minute bins, 0..95 (times ≥ 24h wrap around)


class _PtVolumeExtractor(xml.sax.handler.ContentHandler):
    """Accumulates passenger volumes per (link, line, 15-min bin).

    Occupancy counting: passengers are PersonEntersVehicle events on a
    transit vehicle, excluding the vehicle's current driver. Every
    'entered link' of an occupied transit vehicle adds its current
    occupancy to that link/line/bin cell.
    """

    _RELEVANT = frozenset([
        "TransitDriverStarts", "PersonEntersVehicle", "PersonLeavesVehicle",
        "entered link", "vehicle leaves traffic",
    ])

    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        super().__init__()
        self._con = con
        self._veh_line: dict[str, str] = {}    # vehicle → transit line id
        self._veh_driver: dict[str, str] = {}  # vehicle → current driver person
        self._occ: dict[str, int] = {}         # vehicle → passengers on board
        self._acc: dict[tuple[str, str, int], int] = defaultdict(int)
        self._events_seen = 0
        self._flushed_rows = 0

    def startElement(self, name, attrs) -> None:
        if name != "event":
            return
        etype = attrs.get("type")
        if etype not in self._RELEVANT:
            return

        if etype == "TransitDriverStarts":
            veh = attrs.get("vehicleId")
            if veh:
                self._veh_line[veh] = attrs.get("transitLineId") or "?"
                self._veh_driver[veh] = attrs.get("driverId") or ""
                self._occ[veh] = 0
            return

        veh = attrs.get("vehicle")
        if veh is None or veh not in self._veh_line:
            return
        self._events_seen += 1

        if etype == "PersonEntersVehicle":
            if attrs.get("person") != self._veh_driver.get(veh):
                self._occ[veh] = self._occ.get(veh, 0) + 1
        elif etype == "PersonLeavesVehicle":
            if attrs.get("person") != self._veh_driver.get(veh):
                self._occ[veh] = max(0, self._occ.get(veh, 0) - 1)
        elif etype == "entered link":
            occ = self._occ.get(veh, 0)
            if occ > 0:
                link = attrs.get("link")
                if link:
                    tbin = (int(float(attrs.get("time", 0))) // BIN_SECONDS) % 96
                    self._acc[(link, self._veh_line[veh], tbin)] += occ
                    if len(self._acc) >= FLUSH_KEYS:
                        self._flush()
        elif etype == "vehicle leaves traffic":
            # departure finished — the vehicle id may be reused by a later
            # TransitDriverStarts; reset occupancy defensively
            self._occ[veh] = 0

    def _flush(self) -> None:
        if not self._acc:
            return
        rows = [(k[0], k[1], k[2], v) for k, v in self._acc.items()]
        self._con.executemany(
            "INSERT INTO _pt_vol_staging VALUES (?, ?, ?, ?)", rows)
        self._flushed_rows += len(rows)
        print(f"  ... flushed {self._flushed_rows:,} cells "
              f"({self._events_seen:,} transit events)")
        self._acc.clear()

    def endDocument(self) -> None:
        self._flush()
        print(f"  Total: {self._flushed_rows:,} cells from "
              f"{self._events_seen:,} transit-vehicle events, "
              f"{len(self._veh_line):,} transit vehicles")


def build_transit_volumes(events_xml: str | Path, db_path: str | Path,
                          memory_limit: str = "8GB") -> None:
    events_xml = Path(events_xml)
    db_path = Path(db_path)
    if not events_xml.exists():
        raise FileNotFoundError(events_xml)
    if not db_path.exists():
        raise FileNotFoundError(db_path)

    con = duckdb.connect(str(db_path))
    con.execute(f"SET memory_limit='{memory_limit}'")
    con.execute("INSTALL spatial; LOAD spatial")

    print("[1/3] Extracting PT volumes from events ...")
    con.execute("""CREATE OR REPLACE TEMP TABLE _pt_vol_staging (
        link_id VARCHAR, line_id VARCHAR, time_bin SMALLINT, volume INTEGER)""")
    handler = _PtVolumeExtractor(con)
    opener = gzip.open if events_xml.suffix == ".gz" else open
    with opener(events_xml, "rb") as f:
        xml.sax.parse(f, handler)

    print("[2/3] Writing pt_link_volumes table ...")
    con.execute("""
        CREATE OR REPLACE TABLE pt_link_volumes AS
        SELECT link_id, line_id, time_bin, SUM(volume)::INTEGER AS volume
        FROM _pt_vol_staging
        GROUP BY link_id, line_id, time_bin""")
    con.execute("CREATE INDEX IF NOT EXISTS idx_ptv_link ON pt_link_volumes(link_id)")
    n = con.execute("SELECT COUNT(*), COUNT(DISTINCT line_id) FROM pt_link_volumes").fetchone()
    print(f"  pt_link_volumes: {n[0]:,} rows, {n[1]:,} lines")

    print("[3/3] Backfilling canton_id for pt links (spatial) ...")
    updated = con.execute("""
        UPDATE network_links nl
        SET canton_id = (
            SELECT CAST(SPLIT_PART(hp.polygon_id, ':', 2) AS INTEGER)
            FROM hot_polygons hp
            WHERE hp.polygon_type = 'canton'
              AND ST_Intersects(nl.geom, hp.polygon_geom)
            LIMIT 1)
        WHERE nl.canton_id IS NULL
          AND EXISTS (SELECT 1 FROM pt_link_volumes v WHERE v.link_id = nl.link_id)
    """).fetchone()
    still_null = con.execute("""
        SELECT COUNT(*) FROM network_links nl
        WHERE nl.canton_id IS NULL
          AND EXISTS (SELECT 1 FROM pt_link_volumes v WHERE v.link_id = nl.link_id)
    """).fetchone()[0]
    print(f"  canton backfill done (links still without canton: {still_null:,})")

    con.close()
    print("Done.")

"""Build link_speeds.parquet from MATSim events + network XML.

Computes realised average speeds per link per 15-minute time bin by
pairing "entered link" / "vehicle leaves traffic" events to measure
how long each vehicle spends on each link.

Pipeline
--------
  1. SAX-parse network XML → link attributes (length, freespeed, road_type)
     and node coordinates (for canton assignment).
  2. Query output_events.parquet with DuckDB → per-vehicle per-link travel
     times via LEAD() window function.
  3. Join with link attributes, compute speed = length / travel_time.
  4. Optionally assign canton to each link via spatial join with canton
     GeoJSON (point-in-polygon on link midpoint).
  5. Aggregate into 15-min bins → write link_speeds.parquet.

Input files
-----------
  output_network.xml       – MATSim network with osm:way:highway attribute
  output_events.parquet    – Columnar event log (much faster than XML)
  TLM_KANTONSGEBIET.geojson – Canton boundaries (optional, for zone filter)

Output
------
  link_speeds.parquet      – One row per (link_id, time_bin) combination
"""

from __future__ import annotations

import xml.sax
import xml.sax.handler
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq


# ─── Step 1: SAX parser for network XML ──────────────────────────────

class _NetworkParser(xml.sax.handler.ContentHandler):
    """Extract link attributes and node coordinates from MATSim network XML.

    For each link: id, length, freespeed, capacity, permlanes, modes,
    from_node, to_node, and the nested osm:way:highway attribute.
    For each node: id, x, y coordinates (LV95).
    """

    def __init__(self) -> None:
        super().__init__()
        # Node coordinates: node_id → (x, y)
        self.nodes: dict[str, tuple[float, float]] = {}
        # Link attributes: link_id → dict
        self.links: dict[str, dict] = {}

        self._current_link_id: str | None = None
        self._in_highway_attr: bool = False
        self._char_buf: list[str] = []
        self._count = 0

    def startElement(self, name: str, attrs: xml.sax.xmlreader.AttributesImpl) -> None:
        if name == "node":
            nid = attrs.get("id")
            x = attrs.get("x")
            y = attrs.get("y")
            if nid and x and y:
                self.nodes[nid] = (float(x), float(y))

        elif name == "link":
            lid = attrs.get("id")
            if lid:
                self._current_link_id = lid
                self.links[lid] = {
                    "from": attrs.get("from", ""),
                    "to": attrs.get("to", ""),
                    "length": float(attrs.get("length", 0)),
                    "freespeed": float(attrs.get("freespeed", 0)),
                    "capacity": float(attrs.get("capacity", 0)),
                    "permlanes": float(attrs.get("permlanes", 1)),
                    "modes": attrs.get("modes", ""),
                    "road_type": "unknown",
                }
                self._count += 1
                if self._count % 200_000 == 0:
                    print(f"  ... {self._count:,} links parsed")

        elif name == "attribute" and self._current_link_id is not None:
            if attrs.get("name") == "osm:way:highway":
                self._in_highway_attr = True
                self._char_buf = []

    def characters(self, content: str) -> None:
        if self._in_highway_attr:
            self._char_buf.append(content)

    def endElement(self, name: str) -> None:
        if name == "attribute" and self._in_highway_attr:
            road_type = "".join(self._char_buf).strip()
            if road_type and self._current_link_id in self.links:
                self.links[self._current_link_id]["road_type"] = road_type
            self._in_highway_attr = False
            self._char_buf = []
        elif name == "link":
            self._current_link_id = None


# ─── LV95 → WGS84 conversion (swisstopo approximate formulas) ───────

def _lv95_to_wgs84(x: float, y: float) -> tuple[float, float]:
    """Convert LV95 (E, N) to WGS84 (lon, lat)."""
    y_aux = (x - 2_600_000) / 1_000_000
    x_aux = (y - 1_200_000) / 1_000_000

    lon = (2.6779094
           + 4.728982 * y_aux
           + 0.791484 * y_aux * x_aux
           + 0.1306 * y_aux * x_aux ** 2
           - 0.0436 * y_aux ** 3) * 100.0 / 36.0

    lat = (16.9023892
           + 3.238272 * x_aux
           - 0.270978 * y_aux ** 2
           - 0.002528 * x_aux ** 2
           - 0.0447 * y_aux ** 2 * x_aux
           - 0.0140 * x_aux ** 3) * 100.0 / 36.0

    return lon, lat


# ─── Main build function ────────────────────────────────────────────

TIME_BIN_MINUTES = 15


def build_link_speeds(
    network_xml: str | Path,
    events_parquet: str | Path,
    output_parquet: str | Path,
    canton_geojson: str | Path | None = None,
    memory_limit: str = "4GB",
) -> None:
    """Build link_speeds.parquet from network XML + events parquet.

    Parameters
    ----------
    network_xml      : path to output_network.xml (with osm:way:highway)
    events_parquet   : path to output_events.parquet
    output_parquet   : path where link_speeds.parquet will be written
    canton_geojson   : path to TLM_KANTONSGEBIET.geojson (optional)
    memory_limit     : DuckDB memory limit (default 4GB)
    """
    network_xml = Path(network_xml)
    events_parquet = Path(events_parquet)
    output_parquet = Path(output_parquet)

    for f in [network_xml, events_parquet]:
        if not f.exists():
            raise FileNotFoundError(f"Input not found: {f}")

    if canton_geojson is not None:
        canton_geojson = Path(canton_geojson)
        if not canton_geojson.exists():
            print(f"  Warning: {canton_geojson} not found, skipping canton assignment")
            canton_geojson = None

    output_parquet.parent.mkdir(parents=True, exist_ok=True)

    # ── Step 1: Parse network XML ──────────────────────────────────
    print(f"[1/4] Parsing {network_xml.name} ...")
    print(f"  Input size: {network_xml.stat().st_size / 1e9:.2f} GB")

    handler = _NetworkParser()
    parser = xml.sax.make_parser()
    parser.setContentHandler(handler)
    parser.parse(str(network_xml))

    print(f"  {len(handler.nodes):,} nodes, {len(handler.links):,} links parsed")

    # Build link lookup table as a DuckDB table for joining
    con = duckdb.connect(":memory:")
    con.execute(f"SET memory_limit = '{memory_limit}'")

    link_ids = []
    lengths = []
    freespeeds = []
    road_types = []
    capacities = []
    permlanes_list = []
    mid_xs = []
    mid_ys = []

    for lid, attrs in handler.links.items():
        link_ids.append(lid)
        lengths.append(attrs["length"])
        freespeeds.append(attrs["freespeed"])
        road_types.append(attrs["road_type"])
        capacities.append(attrs["capacity"])
        permlanes_list.append(attrs["permlanes"])

        # Compute link midpoint from node coordinates
        from_node = handler.nodes.get(attrs["from"])
        to_node = handler.nodes.get(attrs["to"])
        if from_node and to_node:
            mid_xs.append((from_node[0] + to_node[0]) / 2)
            mid_ys.append((from_node[1] + to_node[1]) / 2)
        else:
            mid_xs.append(None)
            mid_ys.append(None)

    link_table = pa.table({
        "link_id": pa.array(link_ids, type=pa.string()),
        "length": pa.array(lengths, type=pa.float64()),
        "freespeed": pa.array(freespeeds, type=pa.float64()),
        "road_type": pa.array(road_types, type=pa.string()),
        "capacity": pa.array(capacities, type=pa.float64()),
        "permlanes": pa.array(permlanes_list, type=pa.float64()),
        "mid_x": pa.array(mid_xs, type=pa.float64()),
        "mid_y": pa.array(mid_ys, type=pa.float64()),
    })
    con.execute("CREATE TABLE network_links AS SELECT * FROM link_table")

    # Free memory
    del handler, link_ids, lengths, freespeeds, road_types
    del capacities, permlanes_list, mid_xs, mid_ys, link_table

    print(f"  Network links loaded into DuckDB")

    # ── Step 2: Compute per-link travel times from events ──────────
    print(f"[2/4] Computing link travel times from {events_parquet.name} ...")
    print(f"  Input size: {events_parquet.stat().st_size / 1e6:.0f} MB")

    # Use LEAD() to pair each "enter" event with the next event for the
    # same vehicle.  The time difference = time spent on the current link.
    #
    # Event sequence per vehicle:
    #   VET(link_A, t1) → EL(link_B, t2) → EL(link_C, t3) → VLT(link_C, t4)
    #
    # LEAD on (VET, EL, VLT) ordered by time:
    #   VET(A, t1) → next t2  →  travel_time on A = t2 - t1
    #   EL(B, t2)  → next t3  →  travel_time on B = t3 - t2
    #   EL(C, t3)  → next t4  →  travel_time on C = t4 - t3
    #   VLT(C, t4) → NULL     →  filtered out

    bin_seconds = TIME_BIN_MINUTES * 60

    con.execute(f"""
        CREATE TABLE link_speeds_raw AS
        WITH car_events AS (
            SELECT time, type, vehicle, link
            FROM read_parquet('{events_parquet}')
            WHERE type IN ('vehicle enters traffic', 'entered link',
                           'vehicle leaves traffic')
              AND vehicle LIKE '%:car'
        ),
        -- LEAD window includes VLT events so the last link in a trip
        -- gets its correct leave-time (VLT timestamp), not the start
        -- of the next trip.
        sequenced AS (
            SELECT
                type,
                link,
                time AS enter_time,
                LEAD(time) OVER (
                    PARTITION BY vehicle ORDER BY time
                ) AS leave_time
            FROM car_events
        )
        SELECT
            link AS link_id,
            CAST(FLOOR(enter_time / {bin_seconds}) * {TIME_BIN_MINUTES}
                 AS INTEGER) AS time_bin,
            leave_time - enter_time AS travel_time
        FROM sequenced
        -- Only keep "entered link" events (not VET = first link of trip,
        -- since the vehicle starts mid-link and the travel time is too short).
        -- Similarly VLT rows are excluded (they have no "enter" event).
        WHERE type = 'entered link'
          AND leave_time IS NOT NULL
          AND leave_time > enter_time
          AND leave_time - enter_time < 3600
    """)

    raw_cnt = con.execute("SELECT COUNT(*) FROM link_speeds_raw").fetchone()[0]
    print(f"  {raw_cnt:,} link traversals extracted")

    # ── Step 3: Aggregate + join with network attributes ───────────
    print("[3/4] Aggregating by link + time bin ...")

    con.execute("""
        CREATE TABLE link_speeds_agg AS
        SELECT
            s.link_id,
            s.time_bin,
            n.length,
            n.freespeed,
            n.road_type,
            n.capacity,
            n.permlanes,
            n.mid_x,
            n.mid_y,
            AVG(s.travel_time)          AS avg_travel_time,
            n.length / AVG(s.travel_time) AS avg_speed,
            CASE WHEN n.freespeed > 0
                 THEN (n.length / AVG(s.travel_time)) / n.freespeed
                 ELSE NULL
            END                          AS congestion_index,
            COUNT(*)::INTEGER            AS volume,
            MIN(s.travel_time)           AS min_travel_time,
            MAX(s.travel_time)           AS max_travel_time
        FROM link_speeds_raw s
        INNER JOIN network_links n ON s.link_id = n.link_id
        GROUP BY s.link_id, s.time_bin,
                 n.length, n.freespeed, n.road_type,
                 n.capacity, n.permlanes, n.mid_x, n.mid_y
    """)

    agg_cnt = con.execute("SELECT COUNT(*) FROM link_speeds_agg").fetchone()[0]
    unique_links = con.execute(
        "SELECT COUNT(DISTINCT link_id) FROM link_speeds_agg"
    ).fetchone()[0]
    print(f"  {agg_cnt:,} rows ({unique_links:,} unique links)")

    # ── Step 4 (optional): Assign canton via spatial join ──────────
    if canton_geojson is not None:
        print("[4/4] Assigning cantons to links via spatial join ...")
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(f"""
            CREATE TEMP TABLE canton_boundaries AS
            SELECT KANTONSNUMMER AS canton_id, NAME AS canton_name,
                   CAST(geom AS GEOMETRY) AS geom
            FROM ST_Read('{canton_geojson}')
        """)

        # Add canton_id column via point-in-polygon on link midpoint
        con.execute("ALTER TABLE link_speeds_agg ADD COLUMN canton_id INTEGER")
        con.execute("""
            UPDATE link_speeds_agg
            SET canton_id = (
                SELECT c.canton_id
                FROM canton_boundaries c
                WHERE ST_Contains(c.geom, ST_Point(
                    (2.6779094
                     + 4.728982 * ((mid_x - 2600000.0) / 1000000.0)
                     + 0.791484 * ((mid_x - 2600000.0) / 1000000.0)
                                 * ((mid_y - 1200000.0) / 1000000.0)
                     + 0.1306   * ((mid_x - 2600000.0) / 1000000.0)
                                 * POWER((mid_y - 1200000.0) / 1000000.0, 2)
                     - 0.0436   * POWER((mid_x - 2600000.0) / 1000000.0, 3)
                    ) * 100.0 / 36.0,
                    (16.9023892
                     + 3.238272  * ((mid_y - 1200000.0) / 1000000.0)
                     - 0.270978  * POWER((mid_x - 2600000.0) / 1000000.0, 2)
                     - 0.002528  * POWER((mid_y - 1200000.0) / 1000000.0, 2)
                     - 0.0447    * POWER((mid_x - 2600000.0) / 1000000.0, 2)
                                 * ((mid_y - 1200000.0) / 1000000.0)
                     - 0.0140    * POWER((mid_y - 1200000.0) / 1000000.0, 3)
                    ) * 100.0 / 36.0
                ))
                LIMIT 1
            )
            WHERE mid_x IS NOT NULL AND mid_y IS NOT NULL
        """)

        mapped = con.execute(
            "SELECT COUNT(DISTINCT link_id) FROM link_speeds_agg WHERE canton_id IS NOT NULL"
        ).fetchone()[0]
        print(f"  {mapped:,} / {unique_links:,} links assigned to cantons")

        con.execute("DROP TABLE IF EXISTS canton_boundaries")
    else:
        print("[4/4] Skipping canton assignment (no GeoJSON provided)")
        con.execute("ALTER TABLE link_speeds_agg ADD COLUMN canton_id INTEGER")

    # ── Write output parquet ───────────────────────────────────────
    print(f"Writing {output_parquet} ...")

    result = con.execute("""
        SELECT
            link_id,
            time_bin,
            ROUND(length, 2)            AS length,
            ROUND(freespeed, 4)         AS freespeed,
            road_type,
            ROUND(capacity, 1)          AS capacity,
            permlanes,
            ROUND(avg_travel_time, 2)   AS avg_travel_time,
            ROUND(avg_speed, 4)         AS avg_speed,
            ROUND(congestion_index, 4)  AS congestion_index,
            volume,
            canton_id
        FROM link_speeds_agg
        ORDER BY link_id, time_bin
    """).fetch_arrow_table()

    pq.write_table(result, str(output_parquet), compression="zstd")
    con.close()

    size_mb = output_parquet.stat().st_size / 1e6
    print(f"\nOutput: {output_parquet} ({size_mb:.1f} MB)")
    print(f"  {agg_cnt:,} rows")
    print(f"  {unique_links:,} unique links")
    print(f"  Time bins: {TIME_BIN_MINUTES}-minute intervals")

    # Print summary stats
    con2 = duckdb.connect(":memory:")
    summary = con2.execute(f"""
        SELECT
            road_type,
            COUNT(DISTINCT link_id) AS links,
            ROUND(AVG(avg_speed) * 3.6, 1) AS avg_speed_kmh,
            ROUND(AVG(freespeed) * 3.6, 1) AS freespeed_kmh,
            ROUND(AVG(congestion_index), 3) AS avg_congestion_idx,
            SUM(volume) AS total_traversals
        FROM read_parquet('{output_parquet}')
        GROUP BY road_type
        ORDER BY total_traversals DESC
    """).fetchall()
    con2.close()

    print("\n  Road type summary:")
    print(f"  {'Type':<20} {'Links':>6} {'Avg km/h':>9} {'Free km/h':>10} "
          f"{'Cong.Idx':>9} {'Traversals':>11}")
    print(f"  {'-'*20} {'-'*6} {'-'*9} {'-'*10} {'-'*9} {'-'*11}")
    for row in summary:
        print(f"  {row[0]:<20} {row[1]:>6,} {row[2]:>9} {row[3]:>10} "
              f"{row[4]:>9} {row[5]:>11,}")

"""Build spider.duckdb from raw MATSim events XML + person/household parquets.

Single preprocessing step that produces the only file the backend needs
for spider analysis at runtime.

Pipeline (all inside this script):
  1. SAX-stream output_events.xml → extract car trip routes
  2. Write routes into DuckDB table `spider_routes`
  3. Build inverted index table `spider_link_index` (SQL, inside DuckDB)
  4. Import persons + households parquets as tables
  5. Create DB indexes for fast lookups

Optionally imports output_trips and assigns an origin/dest zone to each trip
by point-in-polygon against a zone GeoJSON. The zoning is parametrised (zones
file, id/name properties, CRS) and defaults to the Swiss setup (TLM canton
boundaries, ``KANTONSNUMMER``/``NAME``, EPSG:2056) so existing commands are
unchanged. Example for a non-Swiss study area::

    python main.py events.xml persons.parquet households.parquet spider.duckdb \
        output_trips.parquet vaud_muni.geojson --zone-type municipality \
        --zone-id-property BFS_NUMMER --zone-name-property NAME --crs EPSG:2056

The assigned ids are written to the ``origin_canton_id`` / ``dest_canton_id``
columns whatever the zone type (the backend probes the ``*_zone_id`` spellings
first and these legacy names second — see zone_registry.zone_col).

Input files
-----------
  output_events.xml              – MATSim simulation events
  switzerland_persons.parquet    – person attributes (age, sex, …)
  households.parquet             – household attributes (income)
  <zones>.geojson                – zone boundaries, WGS84 (optional); defaults
                                   to TLM_KANTONSGEBIET.geojson (26 cantons)

Output
------
  spider.duckdb                  – self-contained DB for spider analysis
"""

from __future__ import annotations

import xml.sax
import xml.sax.handler
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq


# ─── Step 1: SAX parser for XML → trip routes ───────────────────────

BATCH_SIZE = 200_000  # trips before flushing to DuckDB


class _VehicleState:
    """Mutable state for one vehicle currently being tracked."""
    __slots__ = ("trip_counter", "dep_time", "route", "in_trip")

    def __init__(self) -> None:
        self.trip_counter: int = 0
        self.dep_time: float = 0.0
        self.route: list[str] = []
        self.in_trip: bool = False


class _TripExtractor(xml.sax.handler.ContentHandler):
    """SAX handler that reconstructs car-trip link sequences on the fly.

    Only processes events for car vehicles (vehicle ID ends with ":car").
    Trip boundaries are defined by "vehicle enters traffic" / "vehicle
    leaves traffic" events; "entered link" events are collected as the
    route.

    Maintains state for ALL active vehicles simultaneously because
    MATSim events are sorted by time, not by vehicle (events from
    different vehicles are interleaved).
    """

    _RELEVANT_TYPES = frozenset([
        "vehicle enters traffic",
        "entered link",
        "vehicle leaves traffic",
    ])

    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        super().__init__()
        self._con = con

        # Batch buffers
        self._buf_person: list[str] = []
        self._buf_trip_idx: list[int] = []
        self._buf_dep_time: list[float] = []
        self._buf_links: list[list[str]] = []

        # Per-vehicle state: vehicle_id → _VehicleState
        self._vehicles: dict[str, _VehicleState] = {}

        self._written = 0
        self._events_seen = 0

    def startElement(self, name: str, attrs: xml.sax.xmlreader.AttributesImpl) -> None:
        if name != "event":
            return

        event_type = attrs.get("type")
        if event_type not in self._RELEVANT_TYPES:
            return

        vehicle = attrs.get("vehicle")
        if not vehicle or not vehicle.endswith(":car"):
            return

        self._events_seen += 1
        link = attrs.get("link")

        # Get or create state for this vehicle
        vs = self._vehicles.get(vehicle)
        if vs is None:
            vs = _VehicleState()
            self._vehicles[vehicle] = vs

        if event_type == "vehicle enters traffic":
            if vs.in_trip and vs.route:
                # Previous trip wasn't closed — flush it
                self._emit_trip(vehicle, vs)
                vs.trip_counter += 1
            vs.dep_time = float(attrs.get("time", 0))
            vs.route = []
            if link:
                vs.route.append(link)
            vs.in_trip = True

        elif event_type == "entered link" and vs.in_trip:
            if link:
                vs.route.append(link)

        elif event_type == "vehicle leaves traffic":
            if vs.in_trip and vs.route:
                self._emit_trip(vehicle, vs)
                vs.trip_counter += 1
            vs.route = []
            vs.in_trip = False

    def _emit_trip(self, vehicle: str, vs: _VehicleState) -> None:
        person_id = vehicle.rsplit(":car", 1)[0]
        self._buf_person.append(person_id)
        self._buf_trip_idx.append(vs.trip_counter)
        self._buf_dep_time.append(vs.dep_time)
        self._buf_links.append(list(vs.route))

        if len(self._buf_person) >= BATCH_SIZE:
            self._write_batch()

    def _write_batch(self) -> None:
        if not self._buf_person:
            return
        tbl = pa.table({
            "person_id": pa.array(self._buf_person, type=pa.string()),
            "trip_index": pa.array(self._buf_trip_idx, type=pa.int32()),
            "departure_time": pa.array(self._buf_dep_time, type=pa.float64()),
            "route_links": pa.array(self._buf_links, type=pa.list_(pa.string())),
        })
        self._con.execute("INSERT INTO spider_routes SELECT * FROM tbl")
        self._written += len(self._buf_person)
        print(f"  ... {self._written:,} trips extracted")
        self._buf_person.clear()
        self._buf_trip_idx.clear()
        self._buf_dep_time.clear()
        self._buf_links.clear()

    def endDocument(self) -> None:
        # Flush any still-open trips from all vehicles
        for vehicle, vs in self._vehicles.items():
            if vs.in_trip and vs.route:
                self._emit_trip(vehicle, vs)
        self._write_batch()
        print(f"  Total: {self._written:,} trips from {self._events_seen:,} car events")

    @property
    def total_trips(self) -> int:
        return self._written


# ─── Main build function ────────────────────────────────────────────

def build_spider_db(
    events_xml: str | Path,
    persons_parquet: str | Path,
    households_parquet: str | Path,
    output_db: str | Path,
    output_trips_parquet: str | Path | None = None,
    canton_geojson: str | Path | None = None,
    memory_limit: str = "4GB",
    zone_id_property: str = "KANTONSNUMMER",
    zone_name_property: str = "NAME",
    crs: str = "EPSG:2056",
) -> None:
    """Build spider.duckdb from raw source files.

    Parameters
    ----------
    events_xml           : path to output_events.xml
    persons_parquet      : path to switzerland_persons.parquet
    households_parquet   : path to households.parquet
    output_db            : path where spider.duckdb will be written
    output_trips_parquet : path to output_trips.parquet (optional, for zone flows)
    canton_geojson       : path to the zone GeoJSON (optional, for zone flows).
                           Defaults to the Swiss TLM_KANTONSGEBIET.geojson; any
                           admin-unit GeoJSON (WGS84) works.
    memory_limit         : DuckDB memory limit (default 4GB)
    zone_id_property     : GeoJSON property with the numeric zone id
                           (default ``KANTONSNUMMER`` — Swiss canton number)
    zone_name_property   : GeoJSON property with the zone name (default ``NAME``)
    crs                  : projected CRS of the trip start/end coordinates
                           (default ``EPSG:2056`` = Swiss LV95). EPSG:2056 keeps
                           the exact historical swisstopo LV95→WGS84 formulas so
                           Swiss output is byte-identical; any other CRS uses
                           ``ST_Transform``.
    """
    events_xml = Path(events_xml)
    persons_parquet = Path(persons_parquet)
    households_parquet = Path(households_parquet)
    output_db = Path(output_db)

    for f in [events_xml, persons_parquet, households_parquet]:
        if not f.exists():
            raise FileNotFoundError(f"Input not found: {f}")

    if output_trips_parquet is not None:
        output_trips_parquet = Path(output_trips_parquet)
        if not output_trips_parquet.exists():
            print(f"  Warning: {output_trips_parquet} not found, skipping zone-flow tables")
            output_trips_parquet = None

    # Remove old DB if exists
    if output_db.exists():
        output_db.unlink()
    wal = output_db.with_suffix(".duckdb.wal")
    if wal.exists():
        wal.unlink()

    output_db.parent.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(str(output_db))
    con.execute(f"SET memory_limit = '{memory_limit}'")

    # ── Step 1+2: Parse XML → spider_routes table ────────────────────
    print(f"[1/5] Parsing {events_xml.name} → spider_routes table")
    print(f"  Input size: {events_xml.stat().st_size / 1e9:.2f} GB")

    con.execute("""
        CREATE TABLE spider_routes (
            person_id      VARCHAR,
            trip_index     INTEGER,
            departure_time DOUBLE,
            route_links    VARCHAR[]
        )
    """)

    handler = _TripExtractor(con)
    parser = xml.sax.make_parser()
    parser.setContentHandler(handler)
    parser.parse(str(events_xml))

    # ── Step 3: Build inverted index ─────────────────────────────────
    print("[2/5] Building spider_link_index from spider_routes ...")

    con.execute("""
        CREATE TABLE spider_link_index AS
        SELECT
            link_id,
            person_id,
            trip_index,
            departure_time,
            pos AS position,
            len(route_links) AS route_length
        FROM (
            SELECT
                person_id,
                trip_index,
                departure_time,
                route_links,
                UNNEST(route_links) AS link_id,
                generate_subscripts(route_links, 1) AS pos
            FROM spider_routes
        )
        ORDER BY link_id
    """)

    cnt = con.execute("SELECT COUNT(*) FROM spider_link_index").fetchone()[0]
    print(f"  {cnt:,} index rows created")

    # ── Step 4: Import persons + households ──────────────────────────
    print("[3/5] Importing persons ...")
    con.execute(f"""
        CREATE TABLE persons AS
        SELECT * FROM read_parquet('{persons_parquet}')
    """)
    p_cnt = con.execute("SELECT COUNT(*) FROM persons").fetchone()[0]
    print(f"  {p_cnt:,} persons")

    print("[4/5] Importing households ...")
    con.execute(f"""
        CREATE TABLE households AS
        SELECT * FROM read_parquet('{households_parquet}')
    """)
    h_cnt = con.execute("SELECT COUNT(*) FROM households").fetchone()[0]
    print(f"  {h_cnt:,} households")

    # ── Step 5: Create indexes ───────────────────────────────────────
    print("[5/5] Creating indexes ...")
    con.execute("CREATE INDEX idx_link ON spider_link_index(link_id)")
    con.execute("CREATE INDEX idx_link_trip ON spider_link_index(person_id, trip_index)")
    con.execute("CREATE INDEX idx_routes_trip ON spider_routes(person_id, trip_index)")
    con.execute("CREATE INDEX idx_persons_id ON persons(person_id)")
    print("  Done")

    # ── Step 6 (optional): Import output_trips + canton assignment ─────
    t_cnt = 0
    if output_trips_parquet is not None:
        print("[6/7] Importing output_trips ...")
        con.execute(f"""
            CREATE TABLE output_trips AS
            SELECT
                person,
                trip_number,
                CAST(start_link AS VARCHAR) AS start_link,
                CAST(end_link AS VARCHAR) AS end_link,
                start_x, start_y, end_x, end_y,
                main_mode,
                start_activity_type,
                end_activity_type,
                dep_time
            FROM read_parquet('{output_trips_parquet}')
        """)
        t_cnt = con.execute("SELECT COUNT(*) FROM output_trips").fetchone()[0]
        print(f"  {t_cnt:,} trips")

        # Determine canton for each trip's start and end coordinates
        # using point-in-polygon with canton boundaries (GeoJSON).
        mapped = 0
        if canton_geojson is not None:
            canton_geojson = Path(canton_geojson)
            if not canton_geojson.exists():
                print(f"  Warning: {canton_geojson} not found, skipping canton assignment")
                canton_geojson = None

        if canton_geojson is not None:
            print("[7/7] Assigning origin/dest zones via spatial join ...")
            con.execute("INSTALL spatial; LOAD spatial;")
            # Use a temp table to avoid CRS storage issues with older DB formats
            con.execute(f"""
                CREATE TEMP TABLE canton_boundaries AS
                SELECT "{zone_id_property}" AS canton_id, "{zone_name_property}" AS canton_name,
                       CAST(geom AS GEOMETRY) AS geom
                FROM ST_Read('{canton_geojson}')
            """)

            # Zone GeoJSONs are WGS84; trip start/end coords are in the projected
            # CRS. Build a WGS84 point expression for each end. For the default
            # Swiss LV95 the exact historical swisstopo approximation is kept so
            # output is byte-identical; any other CRS uses ST_Transform.
            def _wgs84_point(x_col: str, y_col: str) -> str:
                if crs == "EPSG:2056":
                    lon = f"""
                        (2.6779094
                         + 4.728982 * (({x_col} - 2600000.0) / 1000000.0)
                         + 0.791484 * (({x_col} - 2600000.0) / 1000000.0) * (({y_col} - 1200000.0) / 1000000.0)
                         + 0.1306   * (({x_col} - 2600000.0) / 1000000.0) * POWER(({y_col} - 1200000.0) / 1000000.0, 2)
                         - 0.0436   * POWER(({x_col} - 2600000.0) / 1000000.0, 3)
                        ) * 100.0 / 36.0
                    """
                    lat = f"""
                        (16.9023892
                         + 3.238272  * (({y_col} - 1200000.0) / 1000000.0)
                         - 0.270978  * POWER(({x_col} - 2600000.0) / 1000000.0, 2)
                         - 0.002528  * POWER(({y_col} - 1200000.0) / 1000000.0, 2)
                         - 0.0447    * POWER(({x_col} - 2600000.0) / 1000000.0, 2) * (({y_col} - 1200000.0) / 1000000.0)
                         - 0.0140    * POWER(({y_col} - 1200000.0) / 1000000.0, 3)
                        ) * 100.0 / 36.0
                    """
                    return f"ST_Point({lon}, {lat})"
                return (f"ST_Transform(ST_Point({x_col}, {y_col}), "
                        f"'{crs}', 'EPSG:4326', always_xy := true)")

            point_start = _wgs84_point("t.start_x", "t.start_y")
            point_end = _wgs84_point("t.end_x", "t.end_y")

            # Add origin_canton_id and dest_canton_id columns
            con.execute("ALTER TABLE output_trips ADD COLUMN origin_canton_id INTEGER")
            con.execute("ALTER TABLE output_trips ADD COLUMN dest_canton_id INTEGER")

            # Update origin zone via spatial join
            con.execute(f"""
                UPDATE output_trips t
                SET origin_canton_id = (
                    SELECT c.canton_id
                    FROM canton_boundaries c
                    WHERE ST_Contains(c.geom, {point_start})
                    LIMIT 1
                )
                WHERE t.start_x IS NOT NULL AND t.start_y IS NOT NULL
            """)

            # Update dest zone via spatial join
            con.execute(f"""
                UPDATE output_trips t
                SET dest_canton_id = (
                    SELECT c.canton_id
                    FROM canton_boundaries c
                    WHERE ST_Contains(c.geom, {point_end})
                    LIMIT 1
                )
                WHERE t.end_x IS NOT NULL AND t.end_y IS NOT NULL
            """)

            mapped = con.execute("""
                SELECT COUNT(*) FROM output_trips
                WHERE origin_canton_id IS NOT NULL AND dest_canton_id IS NOT NULL
            """).fetchone()[0]
            print(f"  {mapped:,} / {t_cnt:,} trips with both cantons assigned")

            # Temp table is auto-dropped on close, but clean up explicitly
            con.execute("DROP TABLE IF EXISTS canton_boundaries")
        else:
            print("  Skipping canton assignment (no canton GeoJSON provided)")
            con.execute("ALTER TABLE output_trips ADD COLUMN origin_canton_id INTEGER")
            con.execute("ALTER TABLE output_trips ADD COLUMN dest_canton_id INTEGER")

        con.execute("CREATE INDEX idx_ot_person ON output_trips(person)")
        con.execute("CREATE INDEX idx_ot_origin_canton ON output_trips(origin_canton_id)")
        con.execute("CREATE INDEX idx_ot_dest_canton ON output_trips(dest_canton_id)")

    con.close()

    size_mb = output_db.stat().st_size / 1e6
    print(f"\nOutput: {output_db} ({size_mb:.0f} MB)")
    print(f"  spider_routes:     {handler.total_trips:,} trips")
    print(f"  spider_link_index: {cnt:,} rows")
    print(f"  persons:           {p_cnt:,}")
    print(f"  households:        {h_cnt:,}")
    if output_trips_parquet is not None:
        print(f"  output_trips:      {t_cnt:,} trips")

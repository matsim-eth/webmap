"""Build a v2 ``synthetic.duckdb`` from the raw outputs of a MATSim/eqasim run.

This is the producer side of ``docs/duckdb-format.md``: it takes the files a
MATSim run drops on disk plus the eqasim trip/activity CSVs, and writes the
single self-contained DuckDB file the webmap backend serves every request from.
Where :mod:`rezone` *re-cuts* an existing dataset, this creates one from
scratch — but the two share every formula that produces the same column, so the
aggregation SQL, the merged-segment builder and the asset writer are imported
from :mod:`rezone` rather than copied.

Inputs are *staged* under a directory with canonical names (see
:data:`REQUIRED_FILES` / :data:`OPTIONAL_FILES`), which is what the upload
endpoint writes::

    <dataset_root>/_ingest_staging/
        eqasim_trips.csv              eqasim_activities.csv
        output_network.xml.gz         output_transitSchedule.xml.gz
        output_events.xml.gz          output_plans.xml.gz        (optional)
        persons.parquet | persons.csv
        households.parquet | households.csv                      (optional)

Run it from the admin panel (``start_ingest_thread``; job status in
``<dataset_root>/.ingest.json``, same shape as ``.rezone.json``) or standalone::

    python ingest.py --staging-dir <dir> --out-dir <dataset dir> \
        --sample-rate 0.01 --run-name my_run

Every formula here is checked against — and mostly ported from — the pipeline
that produced the reference dataset (``eqasim-org/eqasim-switzerland`` branch
``webmap_export``, package ``analysis/webmap_export/``). Ported outright: the
Hilbert curve (``hilbert.py``), the stop/boarding/transfer/route-direction asset
shapes (``transit.py``), the canton/bezirk/gemeinde MIN-on-ties assignment
(``canton.py``), the out-of-home and hourly-departure formulas
(``hot_polygons.py``, ``grids.py``), and the metadata row (``__init__.py``).
Verified against dataset 7036833688: ``trips`` and ``activities`` match
column-for-column on all 296,713 / 371,846 rows, and ``stop_coords``,
``stop_municipality``, ``route_directions``, ``transit_routes``,
``municipalities`` and the ``boarding_data_by_line`` stop ids match entry for
entry. Where that source and this file disagree, the disagreement is deliberate
and listed at the bottom of this docstring.

Semantics worth knowing before changing anything here
-----------------------------------------------------

* **Everything is LV95 (EPSG:2056)** on disk. The only WGS84 in the file is
  inside GeoJSON/JSON static assets, which the frontends consume directly.
* **Transit stop ids are the schedule's stopFacility ids verbatim.** They
  already embed the link (``8503000:0:41/42.link:875616``); composing one from
  the id plus ``linkRefId`` doubles the suffix and every frontend join misses.
* **canton_id is a point-in-polygon result, never a copied attribute.** The
  persons parquet ships its own ``canton_id`` and it disagrees with the home
  point for 12 % of the reference run, so it is ignored — the backend does no
  spatial joins at request time and must be able to trust this column.
* **One point-in-polygon per distinct coordinate.** Persons, trips and
  activities all reference the same facility coordinates, so every PIP, H3
  index and Hilbert key is computed once in ``_pts``/``_pt_meta`` and joined on
  ``(x, y)``. That turns ~1.3 M row-level spatial tests into ~0.2 M — and it
  keeps every spatial join in this build under the ~900k-row size where
  DuckDB 1.5's is trustworthy (see :func:`_step_network`).
* **Passenger counts ship raw by default**, matching every deployed dataset:
  both 7036833688 (1 %) and 6180937002 (5 %) carry
  ``scaled_to_full_population: false``, and nothing in either frontend reads
  the flag, so a scaled dataset would silently sit 100× above its uploaded
  siblings. ``docs/duckdb-format.md`` *documents* scaling by ``1/sample_rate``
  (the boarding, transfer and ``pt_link_volumes`` numbers, exactly the set the
  reference pipeline's ``scale_pt`` switch covers; ``pt_link_volumes`` is a
  table but scales with the assets it must be comparable to; person/trip tables
  always stay raw) — pass ``--scale-transit`` / ``scale_transit=True`` to get
  that documented convention. The ``metadata`` asset records the factor and
  whether it was applied either way.
* **A person's home is their first *home* activity**, and the ~15 % who never
  leave home (12,880 of 88,013 on the reference run, so they have no row in
  ``eqasim_activities.csv``) get theirs from ``output_plans.xml``
  (:func:`ingest_extras.plan_homes`). Without a plans file they are NULL, which
  drops them out of every demographic aggregate.

  The reference pipeline instead joins a STATPOP pickle that is not part of this
  staging contract, **and gets those homes wrong**: measured against dataset
  7036833688, all 75,133 activity-derived homes agree exactly, while the 12,697
  that differ sit a median 86 km apart — and on every one of them the home read
  here matches the persons parquet's own ``canton_id`` (12,697/12,697 vs
  1,751/12,697 for the reference), with 10,408 landing on a household-mate's
  home (vs 0). So the ``hot_polygon_demo`` / ``demo_hex_*`` counts produced here
  legitimately differ from the reference's, most visibly for ``age_0_6`` — small
  children are exactly the agents who never leave home.
* **Freight is dropped by its id.** The eqasim CSVs carry ``freight_*`` agents
  whose ``person_id`` is not a number; ``TRY_CAST`` drops exactly those, which
  reproduces the reference row counts (296,713 trips / 371,846 activities).
  Trips and activities are otherwise *not* filtered against ``persons`` — the
  reference keeps a row whose person the parquet happens not to list.
* **``hot_polygon_*`` and the hex grids are built with :mod:`rezone`'s own SQL**
  (``_demo_agg_sql``, and ``_trip_agg_sql`` through
  :func:`_trip_agg_sql_floor`), verified to reproduce the reference's canton
  rows column-for-column. The out-of-home formula ("has a non-home activity
  covering ``h*3600``") was reverse-engineered against the reference before the
  source pipeline was available, and matches it exactly.

Known divergences from the reference pipeline, all deliberate and logged
------------------------------------------------------------------------

* ``spider_routes`` comes from ``output_plans.xml``'s routed **car** legs, not
  from replaying ``*:car`` vehicles through the events. The reference numbers
  its rows with a per-*vehicle* counter, so its ``spider_link_index ⋈ trips``
  join silently mismatches for anyone whose day mixes modes; the plan's own
  ``trip_index`` is the one that lines up, and using it is a deliberate fix.
* ``households`` is only as rich as the staged households file. With none, the
  table is the distinct household ids of the persons with NULL attributes —
  which zeroes the dashboard's income / cars / bikes / öV-quality charts. The
  reference's 200,766-row table comes from a file outside this contract.
* ``persons.home_pt`` for the agents with no activity row — see above; this is
  the one place the numbers here are deliberately *better* than the reference's.
* H3 cell geometry is written at full precision; the reference rounds the LV95
  ring to millimetres. Cosmetic — the payload is a few percent larger.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import os
import shutil
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

from rezone import (
    _build_merged_segments,
    _cols_of,
    _demo_agg_sql,
    _insert_asset,
    _table_exists,
    _trip_agg_sql,
)

logger = logging.getLogger(__name__)

JOB_FILE = ".ingest.json"

#: Refuse an events file bigger than this. Parsing is a single streaming pass,
#: but the ~25 M-cell link/bin accumulator scales with the run, and a file this
#: size means a population far beyond what the rest of the pipeline was sized
#: for. Gate on the *gzipped* size, which is what the uploader knows.
MAX_EVENTS_BYTES = 2 * 1024 ** 3

STAGING_DIRNAME = "_ingest_staging"

#: Canonical staged names that must all be present.
REQUIRED_FILES: set[str] = {
    "eqasim_trips.csv",
    "eqasim_activities.csv",
    "output_network.xml.gz",
    "output_events.xml.gz",
    "output_transitSchedule.xml.gz",
}
#: Exactly one of these is also required (parquet wins when both are staged).
PERSON_FILES: tuple[str, ...] = ("persons.parquet", "persons.csv")
#: Household attributes (income / cars / bikes / ÖV-Güteklasse). Optional.
HOUSEHOLD_FILES: tuple[str, ...] = ("households.parquet", "households.csv")
#: Everything else the build can use but does not need.
OPTIONAL_FILES: set[str] = {"output_plans.xml.gz", *PERSON_FILES, *HOUSEHOLD_FILES}

#: LV95 domain box for the Hilbert curve. A *constant*, not the data extent:
#: the key must mean the same thing across datasets, and it is what the
#: reference dataset's ``metadata.bbox_lv95`` records
#: (``webmap_export.hilbert.CH_BBOX_LV95``).
BBOX_LV95 = (2400000.0, 1050000.0, 2900000.0, 1300000.0)

#: Hilbert curve order: 2^16 cells per axis over :data:`BBOX_LV95`.
_HILBERT_ORDER = 16
_HILBERT_SIDE = 1 << _HILBERT_ORDER

H3_RESOLUTIONS = (6, 9, 12)
SCHEMA_VERSION = "v2"
SOURCE_TYPE = "synthetic"
HOT_POLYGON_TYPES = ("canton", "bezirk", "gemeinde")

#: Swiss resident population, the denominator for deriving a sample rate.
FULL_POPULATION = 8_700_000
#: Rates a run is snapped to when the derived value lands within 20 % of one.
COMMON_SAMPLE_RATES = (0.01, 0.02, 0.05, 0.1, 0.25, 1.0)

#: 0.1 m in WGS84 — the precision every coordinate in a static asset is written
#: at, matching ``rezone._COORD_DECIMALS``.
_COORD_DECIMALS = 6

#: CSV sentinel for NULL in the bulk loader. Backslash-N never occurs in a
#: MATSim id or a Swiss stop name.
_NULLSTR = "\\N"

#: Step names in build order. ``hot_polygons`` runs *before* ``network``: the
#: link/node ``canton_id`` is a point-in-polygon result, and doing it inside the
#: network CTAS is both simpler and cheaper than a second pass with an UPDATE
#: over 1.9 M geometries.
_STEPS = (
    "hot_polygons", "network", "persons", "trips", "activities", "transit",
    "events", "pt volumes", "transit assets", "plans",
    "aggregates", "merged segments", "metadata", "indexes",
)


# ─── job status (file-based: shared across uvicorn workers) ────────────────

def _write_job(out_root: str | Path, **fields) -> None:
    path = Path(out_root) / JOB_FILE
    try:
        current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        current = {}
    current.update(fields, updated_at=datetime.now(timezone.utc).isoformat())
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(current), encoding="utf-8")
    os.replace(tmp, path)


def read_job(out_root: str | Path) -> dict | None:
    path = Path(out_root) / JOB_FILE
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"state": "error", "detail": "unreadable job file"}


class _Progress:
    """Job-file progress reporter: named steps plus a 0..1 fraction."""

    def __init__(self, out_root: Path | None):
        self.out_root = out_root
        self.index = 0

    def __call__(self, detail: str) -> None:
        # Detail lines are "<step>: <what>" (or bare "<step>"), including the
        # ones the parsers emit through this same callback, so the step index
        # follows from the text — no separate bookkeeping to keep in sync.
        head = detail.split(":", 1)[0].strip()
        if head in _STEPS:
            self.index = _STEPS.index(head) + 1
        logger.info("ingest: %s", detail)
        if self.out_root is not None:
            _write_job(self.out_root, state="running", step=detail,
                       step_index=self.index, n_steps=len(_STEPS),
                       progress=round(self.index / len(_STEPS), 3))


# ─── staging ───────────────────────────────────────────────────────────────

def staged_files(staging_dir: str | Path) -> dict[str, Path]:
    """Map every canonical name present in *staging_dir* to its path."""
    d = Path(staging_dir)
    names = REQUIRED_FILES | OPTIONAL_FILES
    return {n: d / n for n in sorted(names) if (d / n).is_file()}


def validate_staging(staging_dir: str | Path) -> list[str]:
    """Names still missing from *staging_dir*; empty means "ready to build".

    The persons file is reported as ``"persons.parquet|persons.csv"`` because
    either spelling satisfies it — that alternative is why callers should use
    this instead of differencing :data:`REQUIRED_FILES` themselves.
    """
    present = set(staged_files(staging_dir))
    missing = sorted(REQUIRED_FILES - present)
    if not present & set(PERSON_FILES):
        missing.append("|".join(PERSON_FILES))
    return missing


def _check_events_size(path: Path) -> None:
    size = path.stat().st_size
    if size > MAX_EVENTS_BYTES:
        raise ValueError(
            f"{path.name} is {size / 1024 ** 3:.1f} GB, over the "
            f"{MAX_EVENTS_BYTES / 1024 ** 3:.0f} GB ingestion limit")


def derive_sample_rate(person_count: int) -> float:
    """Population share this run represents, snapped to a common rate.

    ``88,013 / 8.7 M = 0.0101`` → ``0.01``. A run that lands nowhere near a
    common rate keeps its raw value rather than being forced onto one.
    """
    raw = round(person_count / FULL_POPULATION, 4)
    for rate in COMMON_SAMPLE_RATES:
        if abs(raw - rate) <= 0.2 * rate:
            return rate
    return max(raw, 1e-6)


# ─── bulk loading (no pandas/pyarrow in this image) ────────────────────────

def _csv_value(v):
    if v is None:
        return _NULLSTR
    if isinstance(v, float):
        if v != v:                       # NaN — no CSV spelling DuckDB accepts
            return _NULLSTR
        if v == math.inf:
            return "Infinity"
        if v == -math.inf:
            return "-Infinity"
    return v


def _copy_rows(con, table: str, rows: Iterable[tuple], tmp_dir: Path,
               columns: str = "") -> int:
    """Bulk-load an iterable of tuples into an existing table.

    Via a temporary CSV and ``COPY``, because ``executemany`` runs at ~5 k
    rows/s here (187 s for a million) while this does ~600 k rows/s — and
    ``link_speeds`` alone is 25 M rows. Takes an *iterable*, so a parser's
    generator is never materialised into a list.
    """
    path = tmp_dir / f"_bulk_{table}.csv"
    n = 0
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        for row in rows:
            writer.writerow([_csv_value(v) for v in row])
            n += 1
    if n:
        con.execute(
            f"COPY {table} {columns} FROM '{path.as_posix()}' "
            f"(FORMAT CSV, HEADER false, NULLSTR '{_NULLSTR}')")
    path.unlink(missing_ok=True)
    return n


def _hilbert(x: float, y: float) -> int:
    """2D Hilbert index of an LV95 point over :data:`BBOX_LV95`.

    A scalar port of ``webmap_export.hilbert.hilbert_2d`` (the numpy original
    cannot be used — this image ships neither numpy nor pandas), so
    ``persons.hilbert_idx`` / ``trips.hilbert_origin`` reproduce the reference
    dataset's values exactly rather than merely resembling them. It is a
    spatial *sort key*: no provider reads it, but it is what makes a
    locality-ordered bulk load cluster nearby rows on the same pages.
    """
    xmin, ymin, xmax, ymax = BBOX_LV95
    side = _HILBERT_SIDE
    hx = min(max(int((x - xmin) / (xmax - xmin) * side), 0), side - 1)
    hy = min(max(int((y - ymin) / (ymax - ymin) * side), 0), side - 1)
    d = 0
    s = side >> 1
    while s > 0:
        rx = 1 if (hx & s) else 0
        ry = 1 if (hy & s) else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                hx = s - 1 - hx
                hy = s - 1 - hy
            hx, hy = hy, hx
        s >>= 1
    return d


def _insert_asset_bytes(con, key: str, payload: bytes,
                        content_type: str = "application/json") -> None:
    """:func:`rezone._insert_asset` for a payload already serialised to bytes.

    ``transit_routes`` and ``municipalities`` are ~50-130 MB of JSON; building
    the whole Python object graph just to hand it to ``json.dumps`` costs an
    extra GB of peak RSS, so those two are streamed feature by feature.
    """
    con.execute(
        "INSERT INTO static_assets (key, content_type, payload) VALUES (?, ?, ?)",
        [key, content_type, payload])


def _json_feature_collection(features: Iterable[bytes]) -> bytes:
    out = bytearray(b'{"type":"FeatureCollection","features":[')
    first = True
    for f in features:
        if not first:
            out += b","
        out += f
        first = False
    out += b"]}"
    return bytes(out)


def _jb(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


# ─── step 2: network ───────────────────────────────────────────────────────

def _step_network(con, parsers, net_path: Path, tmp_dir: Path,
                  progress) -> tuple[int, int]:
    """``network_nodes`` / ``network_links`` from the parsed network.

    Link geometry is the straight two-point ``LINESTRING`` between the link's
    end nodes — verified against the reference, where *every* one of the
    1,857,666 links has exactly two points.

    ``canton_id`` is point-in-polygon for the **nodes** (~50 s for 891,798
    against the 26 canton multipolygons, 194k vertices in total); a link then
    takes the canton of its ``from_node``. Both stay NULL outside Switzerland —
    36,903 links and 12,739 nodes in the reference, mostly artificial ``pt_*``
    links and cross-border tails.

    ⚠ The link canton is **not** a second spatial join, even though the
    reference pipeline (and :mod:`rezone`) test the link's centroid. DuckDB
    1.5's spatial join silently loses matches on a table this size: joining
    1,857,666 centroids against the same 26 polygons left 42,627 links
    unzoned instead of 36,903, and the count *changed with the thread count*
    (114,409 single-threaded) — same query, same data, three different answers,
    with and without an RTREE. Below ~900k rows it is exact (the node join
    reproduces the reference's ``canton_id`` for all 891,798 nodes, and the
    coordinate table for all 296,713 trips and 371,846 activities), so the
    node join is kept and the link canton is derived from it with a plain hash
    join: deterministic, ~3 min faster, and it agrees with the reference's
    centroid rule on 99.84 % of links (1,854,631 of 1,857,666).

    Nodes and links are streamed from the XML straight into the CSV loader
    (``iter_nodes``/``iter_links``, one file pass each) rather than read into a
    ``NetworkData``: 1.9 M link dicts are ~1.5 GB of RSS that the rest of the
    build would rather spend on the events accumulators. A parser without the
    iterators falls back to the whole-file read.
    """
    def rows(kind):
        it = getattr(parsers, f"iter_{kind}", None)
        if it is not None:
            return it(net_path, progress=progress)
        return getattr(parsers.parse_network(net_path, progress=progress), kind)

    con.execute("CREATE TABLE _nodes_raw(node_id VARCHAR, x DOUBLE, y DOUBLE)")
    n_nodes = _copy_rows(con, "_nodes_raw",
                         ((n["node_id"], n["x"], n["y"])
                          for n in rows("nodes")), tmp_dir)
    progress(f"network: zoning {n_nodes:,} nodes")
    con.execute("""
        CREATE TABLE network_nodes AS
        SELECT n.node_id, MIN(c.zid) AS canton_id,
               ANY_VALUE(ST_Point(n.x, n.y)) AS geom
        FROM _nodes_raw n
        LEFT JOIN _poly_canton c ON ST_Within(ST_Point(n.x, n.y), c.polygon_geom)
        GROUP BY n.node_id
    """)
    unzoned = con.execute(
        "SELECT COUNT(*) FILTER (WHERE canton_id IS NULL) FROM network_nodes"
    ).fetchone()[0]
    if unzoned > n_nodes * 0.2:
        # Not fatal — a genuinely foreign network would look like this — but on
        # a Swiss run it means the spatial join lost matches (see the docstring).
        logger.warning("ingest: %d of %d network nodes are outside every canton "
                       "polygon (%.0f%%) — check the boundary set",
                       unzoned, n_nodes, 100 * unzoned / max(n_nodes, 1))

    con.execute("""
        CREATE TABLE _links_raw(
            link_id VARCHAR, from_node VARCHAR, to_node VARCHAR, length DOUBLE,
            capacity DOUBLE, freespeed DOUBLE, permlanes DOUBLE,
            modes VARCHAR, road_type VARCHAR)
    """)
    n_links = _copy_rows(con, "_links_raw", (
        (l["link_id"], l["from_node"], l["to_node"], l["length"], l["capacity"],
         l["freespeed"], l["permlanes"], l["modes"], l["road_type"])
        for l in rows("links")), tmp_dir)
    progress(f"network: building {n_links:,} link geometries")
    con.execute("""
        CREATE TABLE network_links AS
        SELECT l.link_id, l.from_node, l.to_node, l.length, l.capacity,
               l.freespeed, l.permlanes, l.modes,
               -- The parser fills an untagged link with the literal 'unknown';
               -- the reference leaves it NULL, and `major roads` / the road-type
               -- dropdown both read this column, so normalise to NULL here. No
               -- OSM highway value is spelled "unknown", so nothing real is lost.
               NULLIF(l.road_type, 'unknown') AS road_type,
               a.canton_id, ST_MakeLine(a.geom, b.geom) AS geom
        FROM _links_raw l
        JOIN network_nodes a ON a.node_id = l.from_node
        JOIN network_nodes b ON b.node_id = l.to_node
    """)
    con.execute("DROP TABLE _links_raw")
    con.execute("DROP TABLE _nodes_raw")
    return n_nodes, n_links


# ─── step 1: hot_polygons ──────────────────────────────────────────────────

def _step_hot_polygons(con, tmp_dir: Path) -> int:
    """The canton / bezirk / gemeinde polygons every zone-aware provider reads.

    Sourced from :mod:`boundary_loader`, which reads the swissBOUNDARIES3D
    shapefiles bundled with this service. Its absence is fatal and named
    explicitly: without ``hot_polygons`` there is no ``canton_id`` anywhere in
    the dataset, so a half-built file would be worse than no file.
    """
    try:
        from boundary_loader import load_hot_polygons
    except Exception as exc:  # pragma: no cover - import-time environment issue
        raise RuntimeError(
            "boundary_loader.load_hot_polygons() is unavailable "
            f"({exc}) — dataset-backend/boundary_loader.py and the shapefiles "
            "under dataset-backend/boundaries/ are required to assign zones"
        ) from exc

    rows = load_hot_polygons()
    if not rows:
        raise RuntimeError("boundary_loader.load_hot_polygons() returned no polygons")

    con.execute("""
        CREATE TABLE _hp_raw(polygon_id VARCHAR, polygon_type VARCHAR,
                             polygon_name VARCHAR, parent_id VARCHAR, wkt VARCHAR)
    """)
    _copy_rows(con, "_hp_raw", (
        (r["polygon_id"], r["polygon_type"], r["polygon_name"], r.get("parent_id"),
         r["wkt"]) for r in rows), tmp_dir)
    con.execute("""
        CREATE TABLE hot_polygons AS
        SELECT polygon_id, polygon_type, polygon_name, parent_id,
               ST_GeomFromText(wkt) AS polygon_geom
        FROM _hp_raw
    """)
    con.execute("DROP TABLE _hp_raw")
    con.execute("CREATE INDEX idx_hot_polygons_type ON hot_polygons(polygon_type)")
    try:
        con.execute("CREATE INDEX rtree_hot_polygons_geom "
                    "ON hot_polygons USING RTREE(polygon_geom)")
    except Exception:
        pass

    # Materialised per level with its own RTREE, not views over hot_polygons:
    # every point-in-polygon join in this build runs against these, and a view
    # hides the index from the spatial join planner — the difference on 1.9 M
    # link centroids against 26 hundred-thousand-vertex canton multipolygons is
    # minutes versus hours.
    for level in ("canton", "bezirk", "gemeinde"):
        con.execute(f"""
            CREATE TABLE _poly_{level} AS
            SELECT CAST(SPLIT_PART(polygon_id, ':', 2) AS INT) AS zid, polygon_geom
            FROM hot_polygons WHERE polygon_type = '{level}'
        """)
        try:
            con.execute(f"CREATE INDEX rtree_poly_{level} "
                        f"ON _poly_{level} USING RTREE(polygon_geom)")
        except Exception:
            logger.warning("ingest: no RTREE on _poly_%s — zone joins will crawl",
                           level)
    return len(rows)


# ─── the shared coordinate table ───────────────────────────────────────────

def _build_point_meta(con, tmp_dir: Path, progress) -> int:
    """Zone ids, H3 cells and the Hilbert key for every distinct coordinate.

    Persons, trips and activities all point at the same eqasim facilities, so
    the reference run's 1.3 M rows only use ~0.3 M distinct positions. Doing
    the spatial work once here and joining on ``(x, y)`` is what keeps the
    build in the minutes rather than the tens of minutes — and it guarantees a
    trip origin and the activity at the same facility can never disagree about
    which canton they are in.
    """
    con.execute("""
        CREATE TABLE _pts AS
        SELECT x, y, ST_Point(x, y) AS pt FROM (
            SELECT DISTINCT x, y FROM (
                SELECT x, y FROM _acts_raw
                UNION ALL SELECT origin_x, origin_y FROM _trips_raw
                UNION ALL SELECT destination_x, destination_y FROM _trips_raw
                UNION ALL SELECT x, y FROM _home_raw
            ) WHERE x IS NOT NULL AND y IS NOT NULL
        )
    """)
    n = con.execute("SELECT COUNT(*) FROM _pts").fetchone()[0]
    progress(f"point metadata: {n:,} distinct coordinates")

    # MIN() on ties, matching webmap_export.canton's MIN(canton_id): a point on
    # a shared border belongs to the lower-numbered zone, deterministically.
    # Each level is tested independently — a bezirk is *not* derived from the
    # gemeinde's parent, because 154 gemeinden have no bezirk parent at all.
    con.execute("""
        CREATE TABLE _pt_zone AS
        SELECT p.x, p.y, MIN(c.zid) AS canton_id, MIN(b.zid) AS bezirk_id,
               MIN(g.zid) AS gemeinde_id
        FROM _pts p
        LEFT JOIN _poly_canton   c ON ST_Within(p.pt, c.polygon_geom)
        LEFT JOIN _poly_bezirk   b ON ST_Within(p.pt, b.polygon_geom)
        LEFT JOIN _poly_gemeinde g ON ST_Within(p.pt, g.polygon_geom)
        GROUP BY p.x, p.y
    """)

    progress("point metadata: H3 + Hilbert indexing")
    cols = ", ".join(f"h3_res{r} BIGINT" for r in H3_RESOLUTIONS)
    con.execute(f"CREATE TABLE _pt_h3(x DOUBLE, y DOUBLE, {cols}, hilbert UBIGINT)")
    _copy_rows(con, "_pt_h3", _h3_rows(con), tmp_dir)

    con.execute(f"""
        CREATE TABLE _pt_meta AS
        SELECT z.x, z.y, z.canton_id, z.gemeinde_id, z.bezirk_id, h.hilbert,
               {', '.join(f'h.h3_res{r}' for r in H3_RESOLUTIONS)}
        FROM _pt_zone z
        LEFT JOIN _pt_h3 h ON h.x = z.x AND h.y = z.y
    """)
    con.execute("CREATE INDEX idx_pt_meta ON _pt_meta(x, y)")
    con.execute("DROP TABLE _pts")
    con.execute("DROP TABLE _pt_zone")
    con.execute("DROP TABLE _pt_h3")
    return n


def _h3_rows(con):
    """``(x, y, h3_res6, h3_res9, h3_res12, hilbert)`` for every row of ``_pts``.

    H3 is a WGS84 index, so the LV95 points are reprojected in DuckDB (one
    vectorised ``ST_Transform``) and only the lon/lat pairs cross into Python.
    The Hilbert key is computed from the *LV95* coordinate, which is the space
    its bounding box is defined in.
    """
    import h3

    to_int = h3.str_to_int
    latlng = h3.latlng_to_cell
    rows = con.execute("""
        SELECT x, y,
               ST_X(ST_Transform(pt, 'EPSG:2056', 'EPSG:4326', always_xy := true)),
               ST_Y(ST_Transform(pt, 'EPSG:2056', 'EPSG:4326', always_xy := true))
        FROM _pts
    """).fetchall()
    for x, y, lon, lat in rows:
        yield (x, y, *(to_int(latlng(lat, lon, r)) for r in H3_RESOLUTIONS),
               _hilbert(x, y))


# ─── steps 3-5: persons, households, trips, activities ─────────────────────

_CAR_AVAIL = {0: "always", 1: "sometimes", 2: "never"}

#: Canonical buckets (``webmap_export.raw_entities``). A purpose is lower-cased
#: and truncated at the first ``_`` (``freight_loading`` → ``freight``), then
#: anything outside the set becomes ``other``; a mode outside its set becomes
#: ``walk``. Both keep the aggregation columns — which are hardcoded to these
#: five modes and six purposes — from silently dropping trips.
_PURPOSE_BUCKETS = ("home", "work", "education", "shop", "leisure")
_MODE_BUCKETS = ("car", "pt", "walk", "bike", "car_passenger")


def _canonical_purpose(col: str) -> str:
    quoted = ", ".join(f"'{p}'" for p in _PURPOSE_BUCKETS)
    return (f"CASE WHEN {col} IS NULL THEN NULL "
            f"WHEN SPLIT_PART(LOWER(TRIM({col})), '_', 1) IN ({quoted}) "
            f"THEN SPLIT_PART(LOWER(TRIM({col})), '_', 1) ELSE 'other' END")


def _canonical_mode(col: str) -> str:
    quoted = ", ".join(f"'{m}'" for m in _MODE_BUCKETS)
    return (f"CASE WHEN {col} IS NULL THEN NULL "
            f"WHEN REGEXP_REPLACE(LOWER(TRIM({col})), '_loop$', '') IN ({quoted}) "
            f"THEN REGEXP_REPLACE(LOWER(TRIM({col})), '_loop$', '') ELSE 'walk' END")


def _load_input_tables(con, files: dict[str, Path], tmp_dir: Path) -> None:
    """Read the persons/households/trips/activities inputs into raw tables.

    DuckDB reads the parquet and the semicolon CSVs directly — no Python in the
    hot path. ``person_id`` is taken as VARCHAR and ``TRY_CAST`` to BIGINT so
    the ``freight_*`` agents in the eqasim CSVs are dropped rather than raising.
    """
    persons_src = files.get("persons.parquet") or files.get("persons.csv")
    if persons_src is None:
        raise FileNotFoundError("no persons.parquet / persons.csv in the staging dir")
    reader = ("read_parquet" if persons_src.suffix == ".parquet"
              else "read_csv")
    opts = "" if reader == "read_parquet" else ", header=true"
    con.execute(f"CREATE TABLE _persons_raw AS "
                f"SELECT * FROM {reader}('{persons_src.as_posix()}'{opts})")

    hh_src = files.get("households.parquet") or files.get("households.csv")
    if hh_src is not None:
        reader = "read_parquet" if hh_src.suffix == ".parquet" else "read_csv"
        opts = "" if reader == "read_parquet" else ", header=true"
        con.execute(f"CREATE TABLE _households_raw AS "
                    f"SELECT * FROM {reader}('{hh_src.as_posix()}'{opts})")

    con.execute(f"""
        CREATE TABLE _trips_raw AS
        SELECT TRY_CAST(person_id AS BIGINT) AS person_id,
               CAST(person_trip_id AS INTEGER) AS trip_index,
               CAST(origin_x AS DOUBLE) AS origin_x,
               CAST(origin_y AS DOUBLE) AS origin_y,
               CAST(destination_x AS DOUBLE) AS destination_x,
               CAST(destination_y AS DOUBLE) AS destination_y,
               CAST(departure_time AS DOUBLE) AS departure_time,
               CAST(travel_time AS DOUBLE) AS travel_time,
               CAST(routed_distance AS DOUBLE) AS network_distance,
               CAST(euclidean_distance AS DOUBLE) AS crowfly_distance,
               {_canonical_mode('mode')} AS main_mode,
               {_canonical_purpose('preceding_purpose')} AS preceding_purpose,
               {_canonical_purpose('following_purpose')} AS following_purpose
        FROM read_csv('{files['eqasim_trips.csv'].as_posix()}',
                      delim=';', header=true, types={{'person_id':'VARCHAR'}})
        WHERE TRY_CAST(person_id AS BIGINT) IS NOT NULL
    """)
    con.execute(f"""
        CREATE TABLE _acts_raw AS
        SELECT TRY_CAST(person_id AS BIGINT) AS person_id,
               CAST(activity_index AS INTEGER) AS activity_index,
               {_canonical_purpose('purpose')} AS purpose,
               TRY_CAST(start_time AS DOUBLE) AS start_time,
               TRY_CAST(end_time AS DOUBLE) AS end_time,
               CAST(x AS DOUBLE) AS x, CAST(y AS DOUBLE) AS y
        FROM read_csv('{files['eqasim_activities.csv'].as_posix()}',
                      delim=';', header=true,
                      types={{'person_id':'VARCHAR','start_time':'VARCHAR',
                              'end_time':'VARCHAR'}})
        WHERE TRY_CAST(person_id AS BIGINT) IS NOT NULL
          AND x IS NOT NULL AND y IS NOT NULL
    """)

    # Home = the person's **first home activity**, not merely their first one
    # (webmap_export.raw_entities.load_persons_synthetic). A day that starts
    # somewhere else must not put the home there. Plans fill in the agents that
    # have no activity row at all.
    con.execute("CREATE TABLE _home_raw(person_id BIGINT, x DOUBLE, y DOUBLE)")
    con.execute("""
        INSERT INTO _home_raw
        SELECT person_id, arg_min(x, activity_index), arg_min(y, activity_index)
        FROM _acts_raw WHERE purpose = 'home' GROUP BY person_id
    """)


def _fill_plan_homes(con, plans_path: Path, tmp_dir: Path, progress) -> int:
    """Recover the homes the activities CSV has no row for, from the plans file.

    Scoped to the persons that actually need one, which is what makes this
    affordable: the returned dict is a few tens of thousands of entries instead
    of one per agent in the population. Returns how many were recovered.
    """
    import ingest_extras

    missing = [str(r[0]) for r in con.execute("""
        SELECT p.person_id FROM _persons_raw p
        WHERE p.person_id NOT IN (SELECT person_id FROM _home_raw)
    """).fetchall()]
    if not missing:
        return 0
    progress(f"persons: {len(missing):,} homes to recover from output_plans")
    homes = ingest_extras.plan_homes(plans_path, wanted=set(missing), progress=progress)
    rows = []
    for pid, (x, y) in homes.items():
        try:
            rows.append((int(pid), x, y))
        except (TypeError, ValueError):
            continue
    _copy_rows(con, "_home_raw", rows, tmp_dir)
    logger.info("ingest: %d of %d missing homes recovered from output_plans",
                len(rows), len(missing))
    return len(rows)


def _step_persons(con) -> int:
    """``persons`` + ``households``.

    Every column in ``docs/duckdb-format.md`` is emitted whether or not the
    input carries it: the backend aggregates over ``IS NOT NULL`` and omits a
    source rather than showing zeros, which only works if the column exists.
    """
    cols = set(_cols_of(con, con.execute("SELECT current_database()").fetchone()[0],
                        "_persons_raw"))

    def col(name, type_):
        # Always cast, including the NULL branch: an untyped NULL column comes
        # out INTEGER and the shipped schema stops matching the contract.
        return f"CAST(p.{name} AS {type_})" if name in cols else f"CAST(NULL AS {type_})"

    # car_availability is numeric in the eqasim persons parquet (0/1/2) and a
    # string in some exports; both spellings land on always/sometimes/never.
    if "car_availability" not in cols:
        car_avail = "CAST(NULL AS VARCHAR)"
    else:
        cases = " ".join(f"WHEN CAST(p.car_availability AS VARCHAR) IN ('{k}', '{k}.0') "
                         f"THEN '{v}'" for k, v in _CAR_AVAIL.items())
        car_avail = (f"CASE {cases} "
                     "WHEN LOWER(CAST(p.car_availability AS VARCHAR)) IN "
                     "('always','sometimes','never') "
                     "THEN LOWER(CAST(p.car_availability AS VARCHAR)) END")

    # sex: 0/1 in the parquet, occasionally m/f elsewhere.
    sex = ("CASE WHEN LOWER(CAST(p.sex AS VARCHAR)) IN ('1','f','female') THEN 1 "
           "WHEN LOWER(CAST(p.sex AS VARCHAR)) IN ('0','m','male') THEN 0 END"
           if "sex" in cols else "NULL")

    subs = ", ".join(f"{col(f'subscriptions_{s}', 'BOOLEAN')} AS subscriptions_{s}"
                     for s in ("ga", "halbtax", "verbund", "strecke", "gleis7",
                               "junior", "other"))
    h3 = ", ".join(f"m.h3_res{r} AS home_h3_res{r}" for r in (12, 9, 6))
    con.execute(f"""
        CREATE TABLE persons AS
        SELECT CAST(p.person_id AS BIGINT) AS person_id,
               {col('household_id', 'BIGINT')} AS household_id,
               {col('age', 'INTEGER')} AS age,
               CAST({sex} AS INTEGER) AS sex,
               {col('person_weight', 'DOUBLE')} AS person_weight,
               {car_avail} AS car_availability,
               {col('has_driving_license', 'BOOLEAN')} AS has_driving_license,
               {col('employed', 'BOOLEAN')} AS employed,
               {subs},
               m.canton_id, na.n_activities,
               CASE WHEN h.x IS NOT NULL THEN ST_Point(h.x, h.y) END AS home_pt,
               -- 0, not NULL, for a person with no home coordinate: the source
               -- pipeline zero-fills the array before scattering the computed
               -- keys into it, and the column is a sort key, not a location.
               CAST(COALESCE(m.hilbert, 0) AS UBIGINT) AS hilbert_idx, {h3},
               m.gemeinde_id AS _gemeinde_id, m.bezirk_id AS _bezirk_id
        FROM _persons_raw p
        LEFT JOIN _home_raw h USING (person_id)
        LEFT JOIN _pt_meta m ON m.x = h.x AND m.y = h.y
        LEFT JOIN (SELECT person_id, COUNT(*)::INTEGER AS n_activities
                   FROM _acts_raw GROUP BY 1) na USING (person_id)
    """)

    if _table_exists(con, con.execute("SELECT current_database()").fetchone()[0],
                     "_households_raw"):
        hcols = set(_cols_of(con, con.execute("SELECT current_database()").fetchone()[0],
                             "_households_raw"))

        def hcol(name):
            return f"CAST(h.{name} AS VARCHAR)" if name in hcols else "NULL"

        con.execute(f"""
            CREATE TABLE households AS
            SELECT h.household_id::BIGINT AS household_id,
                   {hcol('income_class')} AS income_class,
                   {hcol('n_cars_class')} AS n_cars_class,
                   {hcol('n_bikes_class')} AS n_bikes_class,
                   {hcol('ovgk')} AS ovgk
            FROM _households_raw h
        """)
    else:
        logger.warning("ingest: no households file staged — income_class / "
                       "n_cars_class / n_bikes_class / ovgk will be NULL")
        con.execute("""
            CREATE TABLE households AS
            SELECT DISTINCT household_id,
                   CAST(NULL AS VARCHAR) AS income_class,
                   CAST(NULL AS VARCHAR) AS n_cars_class,
                   CAST(NULL AS VARCHAR) AS n_bikes_class,
                   CAST(NULL AS VARCHAR) AS ovgk
            FROM persons WHERE household_id IS NOT NULL
        """)
    return con.execute("SELECT COUNT(*) FROM persons").fetchone()[0]


def _step_trips(con) -> int:
    con.execute(f"""
        CREATE TABLE trips AS
        SELECT t.person_id, t.trip_index, t.departure_time, t.travel_time,
               t.main_mode, t.preceding_purpose, t.following_purpose,
               t.network_distance, t.crowfly_distance,
               ST_Point(t.origin_x, t.origin_y) AS origin_pt,
               ST_Point(t.destination_x, t.destination_y) AS dest_pt,
               CAST(o.hilbert AS UBIGINT) AS hilbert_origin,
               o.h3_res9 AS origin_h3_res9, d.h3_res9 AS dest_h3_res9,
               o.h3_res6 AS origin_h3_res6, d.h3_res6 AS dest_h3_res6,
               o.canton_id AS origin_canton_id, d.canton_id AS dest_canton_id,
               o.gemeinde_id AS _origin_gemeinde_id,
               d.gemeinde_id AS _dest_gemeinde_id,
               o.bezirk_id AS _origin_bezirk_id
        FROM _trips_raw t
        LEFT JOIN _pt_meta o ON o.x = t.origin_x AND o.y = t.origin_y
        LEFT JOIN _pt_meta d ON d.x = t.destination_x AND d.y = t.destination_y
    """)
    return con.execute("SELECT COUNT(*) FROM trips").fetchone()[0]


def _step_activities(con) -> int:
    """``activities`` with the reference's first/last time convention.

    eqasim writes ``-Infinity`` for the first activity's start and (usually)
    ``Infinity`` for the last one's end. The reference nulls **every** first
    start and last end, including the 2,360 last activities that do carry a
    finite end time, so that is the rule used here: a day's opening and closing
    activity have no bound, and the out-of-home aggregate reads them as ±∞.
    """
    con.execute("""
        CREATE TABLE activities AS
        WITH bounds AS (
            SELECT person_id, MIN(activity_index) AS lo, MAX(activity_index) AS hi
            FROM _acts_raw GROUP BY 1
        )
        SELECT a.person_id, a.activity_index, a.purpose,
               CASE WHEN a.activity_index > b.lo AND isfinite(a.start_time)
                    THEN a.start_time END AS start_time,
               CASE WHEN a.activity_index < b.hi AND isfinite(a.end_time)
                    THEN a.end_time END AS end_time,
               a.activity_index = b.lo AS is_first,
               a.activity_index = b.hi AS is_last,
               ST_Point(a.x, a.y) AS location_pt,
               m.canton_id
        FROM _acts_raw a
        JOIN bounds b USING (person_id)
        LEFT JOIN _pt_meta m ON m.x = a.x AND m.y = a.y
    """)
    return con.execute("SELECT COUNT(*) FROM activities").fetchone()[0]


# ─── steps 6-7: events → link_speeds / pt_link_volumes ─────────────────────

def _step_link_speeds(con, events, tmp_dir: Path) -> int:
    """``link_speeds``: one row per (link, 15-min bin) with a completed traversal.

    ``volume`` is the number of vehicles that **completed** the link in that bin
    (an ``entered link`` matched by a ``left link`` with a positive travel
    time), which is what the reference pipeline counts, and rows exist only
    where that count is non-zero. ``freespeed``, ``road_type`` and ``canton_id``
    come from ``network_links`` via a LEFT JOIN, so a link the events mention
    but the network does not still gets its volume.

    ``avg_speed`` is the **mean of the per-traversal speeds**,
    ``length * Σ(1/tt) / n``, not ``length / mean(tt)``: the two differ whenever
    traversal times vary within a bin, and the first is what the reference
    dataset holds. That needs the parser's ``sum_inv_travel_time``; a parser
    without it falls back to the space-mean form and says so, because a silently
    different speed here shifts the whole congestion ramp.

    ``link_bins`` is a lazy Mapping over ~25 M cells (≈8 GB as a plain dict), so
    its ``items()`` is streamed straight into the CSV loader and never
    materialised.
    """
    con.execute("""
        CREATE TABLE _ls_raw(link_id VARCHAR, time_bin INTEGER,
                             sum_tt DOUBLE, sum_inv_tt DOUBLE, n_tt INTEGER)
    """)
    probe = next(iter(events.link_bins.values()), {})
    has_inv = "sum_inv_travel_time" in probe
    if not has_inv:
        logger.warning("ingest: parser has no sum_inv_travel_time — avg_speed will "
                       "be length/mean(tt), not the mean of per-traversal speeds")
    rows = ((link_id, time_bin, cell["sum_travel_time"],
             cell.get("sum_inv_travel_time"), cell["n_travel_times"])
            for (link_id, time_bin), cell in events.link_bins.items())
    n = _copy_rows(con, "_ls_raw", rows, tmp_dir)
    speed = ("l.length * r.sum_inv_tt / r.n_tt" if has_inv
             else "CASE WHEN r.sum_tt > 0 THEN l.length / (r.sum_tt / r.n_tt) END")
    con.execute(f"""
        CREATE TABLE link_speeds AS
        SELECT r.link_id, r.time_bin, {speed} AS avg_speed,
               r.n_tt AS volume, l.freespeed, l.road_type, l.canton_id
        FROM _ls_raw r LEFT JOIN network_links l USING (link_id)
        WHERE r.n_tt > 0
    """)
    con.execute("DROP TABLE _ls_raw")
    return con.execute("SELECT COUNT(*) FROM link_speeds").fetchone()[0]


def _pt_bin_rows(events, pt_volumes: dict | None, scale: int):
    """``(link_id, line_id, route_id, time_bin, volume)`` for ``pt_link_volumes``.

    ``volume`` is **passengers on board** during the traversal, which is what
    the reference table holds and what the Transit Volumes module labels — not
    the number of vehicle runs. ``parsers.events.pt_link_bins`` accumulates
    exactly that, lazily, so it is streamed rather than materialised; the
    per-15-minute keying matches the backend's ``_TICK_KEYS[time_bin]``.

    ``pt_volumes`` is an optional pre-computed accumulator of the same shape;
    the hourly view is the last resort and is spread evenly over each hour's
    four bins, keeping the hourly total exact — a flat quarter-hour profile is a
    visible approximation, but concentrating an hour's traffic in ``:00`` would
    be a wrong one.
    """
    bins = getattr(events, "pt_link_bins", None)
    if bins is not None:
        for (link_id, line_id, route_id, time_bin), volume in bins.items():
            yield link_id, line_id, route_id, time_bin, volume * scale
        return
    if pt_volumes is not None:
        for (link_id, line_id, route_id, time_bin), volume in pt_volumes.items():
            yield link_id, line_id, route_id, time_bin, volume * scale
        return
    logger.warning("ingest: parser has no pt_link_bins — spreading hourly PT "
                   "volumes over 15-minute bins")
    for (link_id, line_id, route_id, hour), volume in events.pt_link_hourly.items():
        base, extra = divmod(int(volume) * scale, 4)
        for q in range(4):
            v = base + (1 if q < extra else 0)
            if v:
                yield link_id, line_id, route_id, (hour % 24) * 4 + q, v


def _step_pt_link_volumes(con, events, pt_volumes, route_meta: dict, scale: int,
                          tmp_dir: Path) -> int:
    """``pt_link_volumes``: PT passenger volume per link / route / 15-min bin.

    Includes the artificial ``pt_*`` links (stop facility loops and the
    connectors between them). They carry no canton — they are outside every
    polygon or have degenerate geometry — and that is load-bearing:
    ``volumes_by_link_line`` filters by zone and never wanted them, while
    ``stop_line_directions`` scans them *unfiltered* to learn which ``.H``/``.R``
    directions call at each platform. Dropping them makes the transit direction
    filter silently inert.

    Scaled to the full population like the transit assets — this table is the
    one exception to "table data stays raw", because the reference pipeline
    scales it under the same switch as the boardings it must be comparable to.
    """
    con.execute("""
        CREATE TABLE _ptv_raw(link_id VARCHAR, line_id VARCHAR, route_id VARCHAR,
                              time_bin INTEGER, volume INTEGER)
    """)
    n = _copy_rows(con, "_ptv_raw", _pt_bin_rows(events, pt_volumes, scale), tmp_dir)

    con.execute("CREATE TABLE _route_meta(line_id VARCHAR, route_id VARCHAR, "
                "line_name VARCHAR, mode VARCHAR)")
    _copy_rows(con, "_route_meta",
               ((lid, rid, name, mode) for (lid, rid), (name, mode)
                in route_meta.items()), tmp_dir)

    con.execute("""
        CREATE TABLE pt_link_volumes AS
        SELECT r.link_id, r.line_id, r.route_id, m.line_name, m.mode,
               r.time_bin, r.volume, l.canton_id
        FROM _ptv_raw r
        LEFT JOIN _route_meta m ON m.line_id = r.line_id AND m.route_id = r.route_id
        LEFT JOIN network_links l ON l.link_id = r.link_id
    """)
    con.execute("DROP TABLE _ptv_raw")
    con.execute("DROP TABLE _route_meta")
    return n


# ─── step 8: transit static assets ───────────────────────────
#
# Every asset here is keyed by the schedule's **stopFacility id**, which already
# embeds the network link: `8503000:0:41/42.link:875616`. Do not compose one
# from the id and `linkRefId` — that yields `X.link:pt_X.link:pt_X` and every
# frontend join (boardings x coords x transfers x the per-canton stop layers)
# silently misses. The link after `.link:` must exist in `network_links`; the
# webmap derives a stop's position from that link's `to_node` whenever the
# `stop_coords` asset is absent.


def _stop_geo(con, transit, tmp_dir: Path) -> dict:
    """Per-facility ``{lon, lat, bfs, gemeinde, canton_id}``.

    Two independent point-in-polygon tests, deliberately: a stop can have a
    ``bfs`` and no canton (Buesingen, Campione d'Italia) and the reference asset
    records exactly that. Foreign stops get neither.
    """
    con.execute("CREATE TABLE _stops_raw(facility_id VARCHAR, x DOUBLE, y DOUBLE)")
    _copy_rows(con, "_stops_raw",
               ((sid, s["x"], s["y"]) for sid, s in transit.stops.items()), tmp_dir)
    rows = con.execute("""
        SELECT s.facility_id,
               ST_X(ST_Transform(ST_Point(s.x, s.y), 'EPSG:2056', 'EPSG:4326',
                                 always_xy := true)),
               ST_Y(ST_Transform(ST_Point(s.x, s.y), 'EPSG:2056', 'EPSG:4326',
                                 always_xy := true)),
               MIN(g.zid), ANY_VALUE(gp.polygon_name), MIN(c.zid)
        FROM _stops_raw s
        LEFT JOIN _poly_gemeinde g ON ST_Within(ST_Point(s.x, s.y), g.polygon_geom)
        LEFT JOIN hot_polygons gp ON gp.polygon_id = 'gemeinde:' || CAST(g.zid AS VARCHAR)
        LEFT JOIN _poly_canton c ON ST_Within(ST_Point(s.x, s.y), c.polygon_geom)
        GROUP BY s.facility_id, s.x, s.y
    """).fetchall()
    con.execute("DROP TABLE _stops_raw")
    return {fid: {"lon": round(lon, _COORD_DECIMALS), "lat": round(lat, _COORD_DECIMALS),
                  "bfs": bfs, "gemeinde": gname, "canton_id": cid}
            for fid, lon, lat, bfs, gname, cid in rows}


def _boarding_asset(transit, events, stop_geo, scale: int) -> list:
    """``boarding_data_by_line`` — the webmap's entire transit stop layer.

    One entry per line, listing **every** stop its routes call at (in first-seen
    order) whether or not anyone boarded there: the reference keeps its 77,721
    zero-boarding stop entries, and the stop layer is built from this list, so
    dropping them would delete stops from the map.

    ``data`` is the hourly total over the line's routes; ``data_by_direction``
    splits the same numbers by the ``.H``/``.R`` suffix of the route id and is
    written only when there is something to split (a missing key reads as "no
    direction data" downstream, which leaves the filter inert rather than
    empty). Routes with no suffix count toward ``data`` only.

    Hours past midnight **wrap** into 0..23 (``h % 24``), as the reference
    pipeline's ``_hour(t) = (t %% 86400) // 3600`` does — a 25:10 boarding is a
    01:10 boarding, not a discarded one.
    """
    per_line: dict[str, dict] = {}
    for (facility, line_id, route_id, hour), cell in events.boardings.items():
        hour %= 24
        direction = route_id.rsplit(".", 1)[-1] if route_id else ""
        direction = direction if direction in ("H", "R") else ""
        agg = per_line.setdefault(line_id, {}).setdefault(
            facility, {"total": {}, "dirs": {}})
        b, a = cell["boardings"], cell["alightings"]
        tot = agg["total"].setdefault(hour, [0, 0])
        tot[0] += b
        tot[1] += a
        if direction:
            d = agg["dirs"].setdefault(direction, {}).setdefault(hour, [0, 0])
            d[0] += b
            d[1] += a

    def series(by_hour):
        return [{"hour": h, "boardings": by_hour[h][0] * scale,
                 "alightings": by_hour[h][1] * scale}
                for h in sorted(by_hour)]

    out = []
    for line in transit.lines:
        line_id = line["line_id"]
        seen: list[str] = []
        modes: set[str] = set()
        for route in line["routes"]:
            if route.get("mode"):
                modes.add(route["mode"])
            for facility in route["stop_ids"]:
                if facility not in seen:
                    seen.append(facility)
        boardings = per_line.get(line_id, {})
        stops = []
        cantons = set()
        for facility in seen:
            geo = stop_geo.get(facility) or {}
            meta = transit.stops.get(facility) or {}
            agg = boardings.get(facility)
            entry = {
                "stop_id": facility,
                "name": meta.get("name") or "",
                "bfs": geo.get("bfs"),
                "canton_id": geo.get("canton_id"),
                "data": series(agg["total"]) if agg else [],
            }
            if agg and agg["dirs"]:
                entry["data_by_direction"] = {d: series(v)
                                              for d, v in sorted(agg["dirs"].items())}
            if geo.get("canton_id") is not None:
                cantons.add(geo["canton_id"])
            stops.append(entry)
        out.append({
            "line_id": line_id,
            "line_name": line.get("line_name") or line_id,
            "modes": sorted(modes),
            "cantons": sorted(cantons),
            "stops": stops,
        })
    return out


def _flat_routes(transit) -> list[dict]:
    """``[{line_id, line_name, route_id, mode, link_refs, stop_refs, n_departures}]``.

    ``TransitData.flat_routes()`` when the parser offers it (its output is
    byte-identical to the reference pipeline's own schedule flattening);
    otherwise the same shape is folded out of ``lines`` here, so both spellings
    of the parser contract feed identical asset builders.
    """
    flat = getattr(transit, "flat_routes", None)
    if callable(flat):
        return flat()
    return [{"line_id": line["line_id"],
             "line_name": line.get("line_name") or line["line_id"],
             "route_id": route.get("route_id") or "",
             "mode": route.get("mode") or "",
             "link_refs": route.get("link_ids") or [],
             "stop_refs": route.get("stop_ids") or [],
             "n_departures": len(route.get("departures") or [])}
            for line in transit.lines for route in line["routes"]]


def _route_directions_asset(routes, transit, stop_geo) -> dict:
    """``route_directions`` — what labels the ``.H``/``.R`` direction toggle.

    Per line and direction letter, the candidate **termini** (each route's last
    stop) and **origins** (each route's first stop) are tallied separately and
    weighted by *departures*, not by route count: a line typically has a dozen
    rare variants and one route that runs all day, and the toggle should read
    "-> Sursee" for the one that actually runs. ``share`` is the winning
    terminus's share of the direction's departures; ``alternates`` lists the
    rest, descending.

    A candidate without resolvable coordinates is skipped (the map draws a
    marker at ``coord``), and a direction with no resolvable terminus at all is
    omitted entirely rather than emitted half-built. Ported from
    ``webmap_export.transit.build_route_directions``.
    """
    agg: dict[tuple[str, str], dict[str, dict[str, list]]] = {}
    for route in routes:
        direction = (route["route_id"] or "").rsplit(".", 1)[-1]
        if direction not in ("H", "R"):
            continue              # no .H/.R suffix -> no directional terminus
        stop_refs = route["stop_refs"]
        if len(stop_refs) < 2:
            continue
        n_dep = route["n_departures"]
        a = agg.setdefault((route["line_id"], direction),
                           {"terminus": {}, "origin": {}})
        for role, facility in (("terminus", stop_refs[-1]),
                               ("origin", stop_refs[0])):
            slot = a[role].setdefault(facility, [0, 0])
            slot[0] += n_dep
            slot[1] += 1

    def coord(facility):
        geo = stop_geo.get(facility)
        if not geo or geo.get("lon") is None:
            return None
        return [geo["lon"], geo["lat"]]

    def name(facility):
        return (transit.stops.get(facility) or {}).get("name", "")

    def rank(candidates, require_coord: bool):
        items = [(fid, wr) for fid, wr in candidates.items()
                 if not require_coord or coord(fid) is not None]
        return sorted(items, key=lambda kv: (-kv[1][0], -kv[1][1], kv[0]))

    out: dict[str, dict] = {}
    for (line_id, direction), roles in agg.items():
        termini = rank(roles["terminus"], require_coord=True)
        if not termini:
            continue
        win_fid, (win_dep, win_routes) = termini[0]
        total_dep = sum(wr[0] for wr in roles["terminus"].values())
        entry = {
            "terminus": name(win_fid),
            "terminus_id": win_fid,
            "coord": coord(win_fid),
            "n_departures": win_dep,
            "n_routes": win_routes,
            "share": round(win_dep / total_dep, 4) if total_dep else 0.0,
        }
        origins = rank(roles["origin"], True) or rank(roles["origin"], False)
        if origins:
            o_fid = origins[0][0]
            entry["origin"] = name(o_fid)
            entry["origin_id"] = o_fid
            if coord(o_fid) is not None:
                entry["origin_coord"] = coord(o_fid)
        alternates = [{"terminus": name(fid), "terminus_id": fid, "coord": coord(fid),
                       "n_departures": dep, "n_routes": nr}
                      for fid, (dep, nr) in termini[1:]]
        if alternates:
            entry["alternates"] = alternates
        out.setdefault(line_id, {})[direction] = entry
    return out


def _transit_routes_features(con, routes, stop_geo, tmp_dir: Path):
    """One GeoJSON LineString per transit route, in WGS84.

    Geometry is the route's own link chain (start node of the first link, then
    each link's end), not the stop sequence, so a route follows the rails it was
    assigned; a route whose links resolve to fewer than two points falls back to
    its stop coordinates. Routes sharing a line **and** an identical link
    sequence are emitted once — MATSim splits one physical run into many
    departures-only variants.

    Yielded feature by feature: the Swiss asset is ~130 MB of JSON and building
    it as one Python object graph costs about a gigabyte of peak RSS.
    """
    wanted = {lid for route in routes for lid in route["link_refs"]}
    con.execute("CREATE TABLE _route_link_ids(link_id VARCHAR)")
    _copy_rows(con, "_route_link_ids", ((l,) for l in wanted), tmp_dir)
    coords = {
        link_id: ((round(x1, _COORD_DECIMALS), round(y1, _COORD_DECIMALS)),
                  (round(x2, _COORD_DECIMALS), round(y2, _COORD_DECIMALS)))
        for link_id, x1, y1, x2, y2 in con.execute("""
            SELECT link_id, ST_X(ST_PointN(g, 1)), ST_Y(ST_PointN(g, 1)),
                            ST_X(ST_PointN(g, 2)), ST_Y(ST_PointN(g, 2))
            FROM (SELECT l.link_id,
                         ST_Transform(l.geom, 'EPSG:2056', 'EPSG:4326',
                                      always_xy := true) AS g
                  FROM network_links l JOIN _route_link_ids r USING (link_id))
        """).fetchall()
    }
    con.execute("DROP TABLE _route_link_ids")

    seen: set[tuple] = set()
    for route in routes:
        link_refs = tuple(route["link_refs"])
        key = (route["line_id"], link_refs)
        if key in seen:
            continue
        seen.add(key)
        path: list[list[float]] = []
        for link_id in link_refs:
            seg = coords.get(link_id)
            if seg is None:
                continue
            for pt in seg:
                p = [pt[0], pt[1]]
                if not path or path[-1] != p:
                    path.append(p)
        if len(path) < 2:
            path = [[g["lon"], g["lat"]] for g in
                    (stop_geo.get(s) for s in route["stop_refs"])
                    if g and g.get("lon") is not None]
        if len(path) < 2:
            continue
        yield _jb({
            "type": "Feature",
            "properties": {
                "line_id": route["line_id"],
                "route_id": route["route_id"],
                "line_name": route["line_name"],
                "mode": route["mode"],
            },
            "geometry": {"type": "LineString", "coordinates": path},
        })


def _transfer_asset(transfers: dict, transit, stop_geo, scale: int) -> list:
    """``stop_transfer_data_by_canton`` from the counted transfers.

    ``transfers`` is ``parsers.events.EventsData.transfers`` — ``facility ->
    {in, out, lines, dests}``, already attributed to the stop the passenger
    **alighted at**, with ``dests`` naming where the onward leg *ended* (which
    is why a stop never appears among its own destinations). Grouped by that
    stop's canton; stops outside every canton are dropped, since a per-canton
    asset has nowhere to list them.

    Destinations outside the canton are kept — a transfer is not less real for
    crossing a border, and the frontend resolves whatever names it can.
    """
    by_canton: dict[int, dict] = {}
    for facility, d in transfers.items():
        geo = stop_geo.get(facility) or {}
        canton = geo.get("canton_id")
        if canton is None:
            continue
        t_in, t_out = d["in"] * scale, d["out"] * scale
        entry = by_canton.setdefault(int(canton), {"canton_id": int(canton),
                                                   "total_transfers": 0, "stops": []})
        entry["total_transfers"] += t_in
        entry["stops"].append({
            "stop_id": facility,
            "name": (transit.stops.get(facility) or {}).get("name", ""),
            "bfs": geo.get("bfs"),
            "transfers": t_in,
            "total_transfers_in": t_in,
            "total_transfers_out": t_out,
            "line_transfers": {a: {b: n * scale for b, n in tos.items()}
                               for a, tos in d["lines"].items()},
            "stop_transfers": {z: n * scale for z, n in d["dests"].items()},
        })
    out = []
    for canton in sorted(by_canton):
        e = by_canton[canton]
        e["stops"].sort(key=lambda s: s["transfers"], reverse=True)
        out.append(e)
    return out


def _municipalities_features(con):
    """Gemeinde polygons as WGS84 features with ``bfs`` / ``name`` / ``kantonsnum``.

    The canton comes from a point-in-polygon test on the gemeinde's own surface
    rather than from its ``parent_id`` chain: 154 gemeinden have no bezirk
    parent, and their canton would otherwise be NULL.
    """
    for bfs, name, kanton, gj in con.execute("""
        SELECT CAST(SPLIT_PART(g.polygon_id, ':', 2) AS INT) AS bfs,
               g.polygon_name,
               (SELECT MIN(CAST(SPLIT_PART(c.polygon_id, ':', 2) AS INT))
                  FROM hot_polygons c
                 WHERE c.polygon_type = 'canton'
                   AND ST_Contains(c.polygon_geom, ST_PointOnSurface(g.polygon_geom))),
               ST_AsGeoJSON(ST_Transform(g.polygon_geom, 'EPSG:2056', 'EPSG:4326',
                                         always_xy := true))
        FROM hot_polygons g
        WHERE g.polygon_type = 'gemeinde'
        ORDER BY bfs
    """).fetchall():
        yield (b'{"type":"Feature","properties":'
               + _jb({"bfs": bfs, "name": name, "kantonsnum": kanton})
               + b',"geometry":' + gj.encode("utf-8") + b"}")


def _step_transit_assets(con, transit, routes, events, transfers, stop_geo,
                         scale: int, tmp_dir: Path, progress) -> dict:
    progress("transit assets: boardings")
    boarding = _boarding_asset(transit, events, stop_geo, scale)
    _insert_asset(con, "boarding_data_by_line", boarding)

    progress("transit assets: stop coords")
    coords, muni = {}, {}
    for facility, meta in transit.stops.items():
        geo = stop_geo.get(facility) or {}
        name = meta.get("name") or ""
        if geo.get("lon") is not None:
            coords[facility] = [geo["lon"], geo["lat"], name]
        muni[facility] = {"name": name, "bfs": geo.get("bfs"),
                          "gemeinde": geo.get("gemeinde"),
                          "canton_id": geo.get("canton_id")}
    _insert_asset(con, "stop_coords", coords)
    _insert_asset(con, "stop_municipality", muni)

    progress("transit assets: route directions")
    _insert_asset(con, "route_directions",
                  _route_directions_asset(routes, transit, stop_geo))

    progress("transit assets: route geometry")
    _insert_asset_bytes(
        con, "transit_routes",
        _json_feature_collection(_transit_routes_features(con, routes, stop_geo,
                                                          tmp_dir)),
        content_type="application/geo+json")

    progress("transit assets: municipalities")
    _insert_asset_bytes(
        con, "municipalities",
        _json_feature_collection(_municipalities_features(con)),
        content_type="application/geo+json")

    n_transfers = 0
    if transfers:
        progress("transit assets: transfers")
        asset = _transfer_asset(transfers, transit, stop_geo, scale)
        _insert_asset(con, "stop_transfer_data_by_canton", asset)
        n_transfers = sum(len(e["stops"]) for e in asset)
    else:
        logger.warning("ingest: no transfer data - stop_transfer_data_by_canton "
                       "omitted, the dashboard's Transfer Matrix / Transfer "
                       "Destinations plots will be empty for this dataset")
    return {"n_lines": len(boarding), "n_stops": len(coords),
            "n_transfer_stops": n_transfers}


# ─── step 9: plans → spider / node flows ───────────────────────────────────

def _step_plans(con, plans, tmp_dir: Path) -> dict:
    """``spider_routes`` + its inverted index + the turning-movement matrix.

    ``spider_link_index.position`` is **1-based** and ``route_length`` is the
    route's link count, matching the reference exactly (17,095,068 index rows =
    the sum of every route's length). ``node_flow_matrix`` counts consecutive
    link pairs at the node they meet — the ``to_node`` of the first link — which
    is why its total is exactly "index rows minus one per route".

    Only **car** legs are kept, matching the reference (which reconstructs
    these by replaying ``*:car`` vehicles through the events): a walk leg's
    "route" is a straight line between two coordinates, not a path through the
    network, and feeding those to the spider would draw traffic on links nobody
    drove. Routes are otherwise not filtered — a route whose trip eqasim did not
    export still belongs here — and ``freight_*`` agents drop out via the
    ``TRY_CAST``, since they are not persons and have no trips to spider.

    ``trip_index`` is the plan's own trip index, which lines up with
    ``trips.trip_index``. The reference numbers these per *vehicle* instead, so
    its ``spider_link_index ⋈ trips`` join is quietly wrong for anyone whose day
    mixes modes; this is the deliberate fix.
    """
    con.execute("""
        CREATE TABLE _routes_raw(person_id VARCHAR, trip_index INTEGER,
                                 departure_time DOUBLE, links VARCHAR)
    """)
    n = _copy_rows(con, "_routes_raw", (
        (r["person_id"], r["trip_index"], r.get("departure_time"),
         " ".join(r["route_links"]))
        for r in plans.routes
        if r.get("route_links") and r.get("mode", "car") == "car"), tmp_dir)
    con.execute("""
        CREATE TABLE spider_routes AS
        SELECT TRY_CAST(r.person_id AS BIGINT) AS person_id, r.trip_index,
               r.departure_time, STR_SPLIT(r.links, ' ') AS route_links
        FROM _routes_raw r
        WHERE TRY_CAST(r.person_id AS BIGINT) IS NOT NULL
    """)
    con.execute("DROP TABLE _routes_raw")

    con.execute("""
        CREATE TABLE spider_link_index AS
        SELECT unnest(route_links) AS link_id, person_id, trip_index,
               departure_time,
               unnest(range(1, len(route_links) + 1))::INTEGER AS position,
               len(route_links)::INTEGER AS route_length
        FROM spider_routes
    """)
    con.execute("""
        CREATE TABLE node_flow_matrix AS
        SELECT l.to_node AS node_id, p.from_link, p.to_link, COUNT(*)::INTEGER AS n_trips
        FROM (
            SELECT unnest(route_links[1:len(route_links) - 1]) AS from_link,
                   unnest(route_links[2:]) AS to_link
            FROM spider_routes WHERE len(route_links) > 1
        ) p
        JOIN network_links l ON l.link_id = p.from_link
        GROUP BY 1, 2, 3
    """)
    return {
        "spider_routes": con.execute("SELECT COUNT(*) FROM spider_routes").fetchone()[0],
        "parsed_routes": n,
        "spider_link_index": con.execute(
            "SELECT COUNT(*) FROM spider_link_index").fetchone()[0],
        "node_flow_matrix": con.execute(
            "SELECT COUNT(*) FROM node_flow_matrix").fetchone()[0],
    }


def _step_spider_hex(con) -> None:
    """The two link-volume-by-hex tables (documented, not yet read by anything).

    Pure SQL over ``spider_link_index``; ~18 M rows on the Swiss run. They are
    what a future custom-polygon spider / zone-flow view would read, and
    ``rezone`` deliberately drops them, so this is the only place they are ever
    produced.
    """
    con.execute("""
        CREATE TABLE spider_link_volumes_by_hex_res6 AS
        SELECT p.home_h3_res6 AS home_h3_index, s.link_id,
               COUNT(*)::INTEGER AS n_traversals
        FROM spider_link_index s JOIN persons p USING (person_id)
        WHERE p.home_h3_res6 IS NOT NULL
        GROUP BY 1, 2
    """)
    con.execute("""
        CREATE TABLE zone_flow_link_volumes_hex_res6 AS
        SELECT t.origin_h3_res6 AS origin_h3_index, t.dest_h3_res6 AS dest_h3_index,
               s.link_id, COUNT(*)::INTEGER AS n_trips
        FROM spider_link_index s JOIN trips t USING (person_id, trip_index)
        WHERE t.origin_h3_res6 IS NOT NULL AND t.dest_h3_res6 IS NOT NULL
        GROUP BY 1, 2, 3
    """)


# ─── step 10: pre-aggregations ─────────────────────────────────────────────

def _away_sql(alias: str = "a") -> str:
    """Per-person "away from home at hour h" flags.

    Verified against the reference: a person counts as away at hour ``h`` when
    some **non-home** activity covers the instant ``h*3600`` — start inclusive,
    end exclusive, with the day's first start and last end read as ±∞. Matches
    ``hot_polygon_out_of_home`` for canton 1 hour by hour.
    """
    flags = ",\n          ".join(
        f"BOOL_OR(COALESCE({alias}.start_time, -1e18) <= {h * 3600} "
        f"AND COALESCE({alias}.end_time, 1e18) > {h * 3600}) AS h{h}"
        for h in range(24))
    return f"""
        SELECT {alias}.person_id,
          {flags}
        FROM activities {alias}
        WHERE {alias}.purpose <> 'home'
        GROUP BY 1
    """


def _ooh_agg_sql(zone_col: str) -> str:
    aways = ",\n          ".join(
        f"COUNT(*) FILTER (WHERE w.h{h})::INT AS away_h{h}" for h in range(24))
    return f"""
        SELECT p.{zone_col} AS zid, COUNT(*)::INT AS n_persons,
          {aways}
        FROM persons p LEFT JOIN _away w USING (person_id)
        WHERE p.{zone_col} IS NOT NULL
        GROUP BY 1
    """


def _trip_agg_sql_floor(zone_col: str) -> str:
    """:func:`rezone._trip_agg_sql` with the departure hour **floored**.

    ``rezone`` used to write ``CAST(t.departure_time / 3600 AS INT)``, and
    DuckDB's CAST *rounds* — 08:45 lands in ``time_h9``. The reference pipeline
    uses ``FLOOR(departure_time/3600)``, which is what an hour bucket means,
    and the difference is large: rounding moves roughly half of every hour's
    trips one bucket late, flattening the morning peak and inventing a 23:xx
    tail. ``rezone`` was fixed to FLOOR on 2026-08-11; this shim keeps working
    against either spelling and fails loud if the SQL changes shape again.
    """
    sql = _trip_agg_sql(zone_col)
    old = "CAST(t.departure_time / 3600 AS INT)"
    if old in sql:                          # pre-2026-08-11 rezone, still rounding
        return sql.replace(old, "FLOOR(t.departure_time / 3600)")
    if "FLOOR(t.departure_time / 3600)" not in sql:  # changed under us — fail loud
        raise RuntimeError("rezone._trip_agg_sql no longer contains the hour "
                           "expression this patch expects")
    return sql


_FLOW_MODES = ("car", "pt", "walk", "bike", "car_passenger")


def _flow_agg_sql(origin_col: str, dest_col: str) -> str:
    modes = ",\n          ".join(
        f"COUNT(*) FILTER (WHERE t.main_mode = '{m}')::INT AS mode_{m}"
        for m in _FLOW_MODES)
    return f"""
        SELECT t.{origin_col} AS o, t.{dest_col} AS d, COUNT(*)::INT AS n_trips,
          {modes}
        FROM trips t
        WHERE t.{origin_col} IS NOT NULL AND t.{dest_col} IS NOT NULL
        GROUP BY 1, 2
    """


def _cars3_expr(con) -> str:
    """``cars_3_plus`` counts both spellings of the top household-car class.

    Upstream writes ``'3'`` in the households parquet and ``'3+'`` in some
    exports; :mod:`rezone` sniffs which one the source used, and here both are
    simply accepted.
    """
    return "COUNT(*) FILTER (WHERE h.n_cars_class IN ('3', '3+'))"


def _step_aggregates(con, tmp_dir: Path, progress) -> None:
    cars3 = _cars3_expr(con)
    con.execute(f"CREATE TEMP TABLE _away AS {_away_sql()}")

    progress("aggregates: polygons")
    zone_cols = {"canton": "canton_id", "bezirk": "_bezirk_id",
                 "gemeinde": "_gemeinde_id"}
    con.execute("CREATE TABLE hot_polygon_demo AS "
                "SELECT CAST(NULL AS VARCHAR) AS polygon_id, a.* EXCLUDE (zid) "
                f"FROM ({_demo_agg_sql('canton_id', cars3).replace('AS h3', 'AS zid')}) a "
                "LIMIT 0")
    for ptype, col in zone_cols.items():
        sql = _demo_agg_sql(col, cars3).replace("AS h3", "AS zid")
        con.execute(f"""
            INSERT INTO hot_polygon_demo
            SELECT '{ptype}:' || CAST(a.zid AS VARCHAR), a.* EXCLUDE (zid) FROM ({sql}) a
        """)

    trip_cols = {"canton": "origin_canton_id", "bezirk": "_origin_bezirk_id",
                 "gemeinde": "_origin_gemeinde_id"}
    con.execute("CREATE TABLE hot_polygon_trips AS "
                "SELECT CAST(NULL AS VARCHAR) AS polygon_id, a.* EXCLUDE (zid) "
                f"FROM ({_trip_agg_sql_floor('origin_canton_id').replace('AS h3', 'AS zid')}) a "
                "LIMIT 0")
    for ptype, col in trip_cols.items():
        sql = _trip_agg_sql_floor(col).replace("AS h3", "AS zid")
        con.execute(f"""
            INSERT INTO hot_polygon_trips
            SELECT '{ptype}:' || CAST(a.zid AS VARCHAR), a.* EXCLUDE (zid) FROM ({sql}) a
        """)

    con.execute("CREATE TABLE hot_polygon_out_of_home AS "
                "SELECT CAST(NULL AS VARCHAR) AS polygon_id, a.* EXCLUDE (zid) "
                f"FROM ({_ooh_agg_sql('canton_id')}) a LIMIT 0")
    for ptype, col in zone_cols.items():
        con.execute(f"""
            INSERT INTO hot_polygon_out_of_home
            SELECT '{ptype}:' || CAST(a.zid AS VARCHAR), a.* EXCLUDE (zid)
            FROM ({_ooh_agg_sql(col)}) a
        """)

    # Flows: canton and gemeinde pairs only, as in the reference (nothing reads
    # bezirk-level flows and the pair count grows quadratically).
    con.execute("CREATE TABLE hot_polygon_flows AS "
                "SELECT CAST(NULL AS VARCHAR) AS origin_polygon_id, "
                "CAST(NULL AS VARCHAR) AS dest_polygon_id, a.* EXCLUDE (o, d) "
                f"FROM ({_flow_agg_sql('origin_canton_id', 'dest_canton_id')}) a LIMIT 0")
    for ptype, ocol, dcol in (("canton", "origin_canton_id", "dest_canton_id"),
                              ("gemeinde", "_origin_gemeinde_id", "_dest_gemeinde_id")):
        con.execute(f"""
            INSERT INTO hot_polygon_flows
            SELECT '{ptype}:' || CAST(a.o AS VARCHAR),
                   '{ptype}:' || CAST(a.d AS VARCHAR), a.* EXCLUDE (o, d)
            FROM ({_flow_agg_sql(ocol, dcol)}) a
        """)

    progress("aggregates: hex grids")
    _build_hex_geometry(con, tmp_dir)
    for res in H3_RESOLUTIONS:
        # Each grid carries the parent cells *coarser than itself*, down to
        # res6 — res12 has both res9 and res6, res9 only res6, res6 none.
        parent = "".join(f"g.h3_parent_res{r}, " for r in (9, 6) if r < res)
        sql = _demo_agg_sql(f"home_h3_res{res}", cars3)
        con.execute(f"""
            CREATE TABLE demo_hex_res{res} AS
            SELECT a.h3 AS h3_index, {parent}g.cell_geom, g.cell_center,
                   a.* EXCLUDE (h3)
            FROM ({sql}) a JOIN _hex_geom g ON g.h3_index = a.h3
        """)
    con.execute(f"""
        CREATE TABLE trip_hex_origin_res9 AS
        SELECT a.h3 AS h3_index, g.h3_parent_res6, g.cell_geom, a.* EXCLUDE (h3)
        FROM ({_trip_agg_sql_floor('origin_h3_res9')}) a
        JOIN _hex_geom g ON g.h3_index = a.h3
    """)
    con.execute(f"""
        CREATE TABLE oh_hex_res9 AS
        SELECT a.zid AS h3_index, g.h3_parent_res6, g.cell_geom, a.* EXCLUDE (zid)
        FROM ({_ooh_agg_sql('home_h3_res9')}) a
        JOIN _hex_geom g ON g.h3_index = a.zid
    """)
    con.execute(f"""
        CREATE TABLE flow_hex_res9 AS
        SELECT a.o AS origin_h3_index, a.d AS dest_h3_index,
               go.cell_geom AS origin_cell_geom, gd.cell_geom AS dest_cell_geom,
               a.* EXCLUDE (o, d)
        FROM ({_flow_agg_sql('origin_h3_res9', 'dest_h3_res9')}) a
        JOIN _hex_geom go ON go.h3_index = a.o
        JOIN _hex_geom gd ON gd.h3_index = a.d
    """)
    con.execute("DROP TABLE _hex_geom")


def _build_hex_geometry(con, tmp_dir: Path) -> None:
    """``_hex_geom(h3_index, h3_parent_res9/6, cell_geom, cell_center)`` in LV95.

    Only the cells actually used by a grid are materialised: the H3 boundary is
    computed in WGS84 (that is the only CRS H3 knows) and reprojected once in
    DuckDB, so the stored geometry is LV95 like everything else on disk.
    """
    import h3

    cells = con.execute("""
        SELECT DISTINCT h3 FROM (
            SELECT home_h3_res6 AS h3 FROM persons
            UNION ALL SELECT home_h3_res9 FROM persons
            UNION ALL SELECT home_h3_res12 FROM persons
            UNION ALL SELECT origin_h3_res9 FROM trips
            UNION ALL SELECT dest_h3_res9 FROM trips
        ) WHERE h3 IS NOT NULL
    """).fetchall()
    con.execute("""
        CREATE TEMP TABLE _hex_raw(h3_index BIGINT, h3_parent_res9 BIGINT,
                                   h3_parent_res6 BIGINT,
                                   wkt VARCHAR, cx DOUBLE, cy DOUBLE)
    """)

    def rows():
        for (cell,) in cells:
            s = h3.int_to_str(cell)
            res = h3.get_resolution(s)
            ring = h3.cell_to_boundary(s)
            pts = ", ".join(f"{lng} {lat}" for lat, lng in ring)
            first = f"{ring[0][1]} {ring[0][0]}"
            lat, lng = h3.cell_to_latlng(s)
            parents = [h3.str_to_int(h3.cell_to_parent(s, r)) if r < res else None
                       for r in (9, 6)]
            yield (cell, *parents, f"POLYGON (({pts}, {first}))", lng, lat)

    _copy_rows(con, "_hex_raw", rows(), tmp_dir)
    con.execute("""
        CREATE TEMP TABLE _hex_geom AS
        SELECT h3_index, h3_parent_res9, h3_parent_res6,
               ST_Transform(ST_GeomFromText(wkt), 'EPSG:4326', 'EPSG:2056',
                            always_xy := true) AS cell_geom,
               ST_Transform(ST_Point(cx, cy), 'EPSG:4326', 'EPSG:2056',
                            always_xy := true) AS cell_center
        FROM _hex_raw
    """)
    con.execute("DROP TABLE _hex_raw")
    con.execute("CREATE INDEX idx_hex_geom ON _hex_geom(h3_index)")


# ─── steps 11-12: metadata + indexes ───────────────────────────────────────

def _step_metadata(con, run_name: str | None, sample_rate: float,
                   scaled: bool) -> None:
    con.execute("""
        CREATE TABLE metadata(
            schema_version VARCHAR, build_date TIMESTAMP, source_type VARCHAR,
            matsim_run_id VARCHAR, eqasim_commit_hash VARCHAR,
            person_count BIGINT, trip_count BIGINT, activity_count BIGINT,
            grid_resolutions_m INTEGER[], bbox_lv95 DOUBLE[],
            hot_polygon_types VARCHAR[], h3_resolutions INTEGER[],
            has_pt_static BOOLEAN)
    """)
    # matsim_run_id / eqasim_commit_hash stay NULL and has_pt_static FALSE, as
    # the reference pipeline writes them; the run name lives in the metadata
    # *asset*, which is the one every consumer actually reads.
    con.execute("""
        INSERT INTO metadata
        SELECT ?, now()::TIMESTAMP, ?, NULL, NULL,
               (SELECT COUNT(*) FROM persons), (SELECT COUNT(*) FROM trips),
               (SELECT COUNT(*) FROM activities),
               []::INTEGER[], ?, ?, ?, FALSE
    """, [SCHEMA_VERSION, SOURCE_TYPE, list(BBOX_LV95),
          list(HOT_POLYGON_TYPES), list(H3_RESOLUTIONS)])

    _insert_asset(con, "metadata", {
        "sample_rate": sample_rate,
        "run_name": run_name,
        "scaled_to_full_population": scaled,
    })


_INDEXES = (
    ("idx_persons_canton", "persons(canton_id)"),
    ("idx_persons_h3_r6", "persons(home_h3_res6)"),
    ("idx_persons_h3_r9", "persons(home_h3_res9)"),
    ("idx_persons_h3_r12", "persons(home_h3_res12)"),
    ("idx_trips_origin_canton", "trips(origin_canton_id)"),
    ("idx_trips_dest_canton", "trips(dest_canton_id)"),
    ("idx_trips_mode", "trips(main_mode)"),
    ("idx_activities_canton", "activities(canton_id)"),
    ("idx_activities_purpose", "activities(purpose)"),
    ("idx_network_links_canton", "network_links(canton_id)"),
    ("idx_network_links_road_type", "network_links(road_type)"),
    ("idx_network_nodes_canton", "network_nodes(canton_id)"),
    ("idx_link_speeds_link", "link_speeds(link_id)"),
    ("idx_link_speeds_canton", "link_speeds(canton_id)"),
    ("idx_link_speeds_road_type", "link_speeds(road_type)"),
    ("idx_ptlv_canton", "pt_link_volumes(canton_id)"),
    ("idx_ptlv_link", "pt_link_volumes(link_id)"),
    ("idx_nfm_node", "node_flow_matrix(node_id)"),
    ("idx_spider_link", "spider_link_index(link_id)"),
    ("idx_spider_link_trip", "spider_link_index(person_id, trip_index)"),
    ("idx_hot_polygon_demo", "hot_polygon_demo(polygon_id)"),
    ("idx_hot_polygon_trips", "hot_polygon_trips(polygon_id)"),
    ("idx_hot_polygon_ooh", "hot_polygon_out_of_home(polygon_id)"),
    ("idx_hot_polygon_flows", "hot_polygon_flows(origin_polygon_id)"),
    ("idx_static_assets_key", "static_assets(key)"),
)

_RTREES = (
    ("rtree_persons_home", "persons", "home_pt"),
    ("rtree_trips_origin", "trips", "origin_pt"),
    ("rtree_trips_dest", "trips", "dest_pt"),
    ("rtree_activities_loc", "activities", "location_pt"),
    ("rtree_network_links", "network_links", "geom"),
    ("rtree_network_nodes", "network_nodes", "geom"),
    ("rtree_demo_hex_res6", "demo_hex_res6", "cell_geom"),
    ("rtree_demo_hex_res9", "demo_hex_res9", "cell_geom"),
    ("rtree_demo_hex_res12", "demo_hex_res12", "cell_geom"),
    ("rtree_trip_hex_origin_res9", "trip_hex_origin_res9", "cell_geom"),
    ("rtree_oh_hex_res9", "oh_hex_res9", "cell_geom"),
)


def _step_indexes(con) -> None:
    for name, spec in _INDEXES:
        try:
            con.execute(f"CREATE INDEX {name} ON {spec}")
        except Exception:
            pass
    for name, table, col in _RTREES:
        try:
            con.execute(f"CREATE INDEX {name} ON {table} USING RTREE({col})")
        except Exception:
            pass


def _drop_helper_columns(con) -> None:
    """Remove the ``_gemeinde_id``/``_bezirk_id`` scratch columns.

    They ride along on ``persons``/``trips`` so :func:`rezone._demo_agg_sql` and
    :func:`rezone._trip_agg_sql` can group by them unchanged, and are dropped
    afterwards so the shipped schema is exactly the documented one. They are
    appended last, so dropping them leaves the column order untouched.
    """
    for table, cols in (("persons", ("_gemeinde_id", "_bezirk_id")),
                        ("trips", ("_origin_gemeinde_id", "_dest_gemeinde_id",
                                   "_origin_bezirk_id"))):
        for col in cols:
            try:
                con.execute(f"ALTER TABLE {table} DROP COLUMN {col}")
            except Exception:
                logger.warning("ingest: could not drop %s.%s", table, col)


# ─── the build ─────────────────────────────────────────────────────────────

def run_ingest(dataset_root: str | Path, staging_dir: str | Path, *,
               sample_rate: float | None = None, run_name: str | None = None,
               scale_transit: bool = False, with_transfers: bool = True,
               with_plan_homes: bool = True,
               progress: Callable | None = None) -> dict:
    """Build ``<dataset_root>/synthetic.duckdb``. Raises on failure.

    Writes no job file — :func:`run_ingest_job` does that around it.
    """
    import duckdb
    import parsers

    dataset_root, staging_dir = Path(dataset_root), Path(staging_dir)
    dataset_root.mkdir(parents=True, exist_ok=True)
    p = progress or (lambda s: logger.info("ingest: %s", s))

    missing = validate_staging(staging_dir)
    if missing:
        raise FileNotFoundError(
            f"staging dir {staging_dir} is missing: {', '.join(missing)}")
    files = staged_files(staging_dir)
    _check_events_size(files["output_events.xml.gz"])

    out_path = dataset_root / "synthetic.duckdb"
    if out_path.exists():
        out_path.unlink()
    tmp_dir = dataset_root / "_ingest_tmp"
    tmp_dir.mkdir(exist_ok=True)

    stats: dict = {}
    con = duckdb.connect(str(out_path))
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(f"SET temp_directory = '{tmp_dir.as_posix()}'")
        con.execute("CREATE TABLE static_assets(key VARCHAR, content_type VARCHAR, "
                    "payload BLOB)")

        # ── boundaries ─────────────────────────────────────────────────────
        p("hot_polygons")
        stats["hot_polygons"] = _step_hot_polygons(con, tmp_dir)

        # ── network ────────────────────────────────────────────────────────
        p("network: parsing")
        stats["nodes"], stats["links"] = _step_network(
            con, parsers, files["output_network.xml.gz"], tmp_dir, p)

        # ── demand ─────────────────────────────────────────────────────────
        plans_path = files.get("output_plans.xml.gz")
        p("persons: reading inputs")
        _load_input_tables(con, files, tmp_dir)
        if with_plan_homes and plans_path is not None:
            stats["plan_homes"] = _fill_plan_homes(con, plans_path, tmp_dir, p)
        _build_point_meta(con, tmp_dir, p)
        p("persons")
        stats["persons"] = _step_persons(con)
        p("trips")
        stats["trips"] = _step_trips(con)
        p("activities")
        stats["activities"] = _step_activities(con)
        for t in ("_persons_raw", "_households_raw", "_trips_raw", "_acts_raw",
                  "_home_raw"):
            con.execute(f"DROP TABLE IF EXISTS {t}")

        rate = sample_rate or derive_sample_rate(stats["persons"])
        scale = max(1, round(1 / rate)) if scale_transit else 1
        stats["sample_rate"] = rate
        stats["transit_scale_factor"] = scale

        # ── transit schedule + events ──────────────────────────────────────
        p("transit: parsing schedule")
        transit = parsers.parse_transit_schedule(files["output_transitSchedule.xml.gz"],
                                                 progress=p)
        routes = _flat_routes(transit)
        route_meta = {(r["line_id"], r["route_id"]): (r["line_name"], r["mode"])
                      for r in routes}

        # The long one: ~13 min and ~3.3 GB RSS for the 96 M events of a Swiss
        # 1 % run. Its products (link bins, boardings, PT occupancy, transfers)
        # are lazy mappings that get streamed into DuckDB, never materialised.
        p("events: parsing (the long one)")
        events = parsers.parse_events(files["output_events.xml.gz"],
                                      transit.vehicle_to_route, progress=p)
        logger.info("ingest: event stats %s", getattr(events, "stats", {}))

        p("events: link_speeds")
        stats["link_speeds"] = _step_link_speeds(con, events, tmp_dir)

        # Transfers ride along on the same events pass (parsers.events counts
        # them); there is no second stream of the file.
        transfers = getattr(events, "transfers", None) if with_transfers else None

        p("pt volumes")
        stats["pt_link_volumes"] = _step_pt_link_volumes(
            con, events, None, route_meta, scale, tmp_dir)

        p("transit assets")
        stop_geo = _stop_geo(con, transit, tmp_dir)
        stats.update(_step_transit_assets(con, transit, routes, events, transfers,
                                          stop_geo, scale, tmp_dir, p))
        del events, transit, routes, transfers, stop_geo

        # ── plans ──────────────────────────────────────────────────────────
        if plans_path is not None:
            p("plans: parsing")
            plans = parsers.parse_plans(plans_path, progress=p)
            p("plans: spider tables")
            stats.update(_step_plans(con, plans, tmp_dir))
            del plans
        else:
            logger.warning("ingest: no output_plans.xml.gz — the Spider, Node "
                           "Flows and Zone Flows modules will have no data")

        # ── aggregates ─────────────────────────────────────────────────────
        p("aggregates")
        _step_aggregates(con, tmp_dir, p)
        if _table_exists(con, con.execute("SELECT current_database()").fetchone()[0],
                         "spider_link_index"):
            p("aggregates: spider hex volumes")
            _step_spider_hex(con)
        _drop_helper_columns(con)

        p("merged segments")
        stats["merged_segments"] = _build_merged_segments(con, p)

        p("metadata")
        _step_metadata(con, run_name, rate, bool(scale_transit and rate))

        p("indexes")
        _step_indexes(con)
        for t in ("_poly_canton", "_poly_bezirk", "_poly_gemeinde", "_pt_meta"):
            con.execute(f"DROP TABLE IF EXISTS {t}")
        con.execute("CHECKPOINT")
    finally:
        con.close()
        shutil.rmtree(tmp_dir, ignore_errors=True)

    logger.info("ingest: done %s", stats)
    return stats


# ─── job entry points ──────────────────────────────────────────────────────

def run_ingest_job(dataset_root, staging_dir, *, sample_rate: float | None = None,
                   run_name: str | None = None, dataset_id=None, **opts) -> None:
    """Thread target: run the build and persist the outcome to ``.ingest.json``.

    Failures are recorded as ``state="error"`` with ``detail`` (the exception
    message) and ``trace`` (the last 2000 chars of the traceback) — the same
    contract as ``.rezone.json``, so the admin panel can show either job with
    one renderer. The half-built ``synthetic.duckdb`` is left in place for
    inspection; the next successful run deletes it.
    """
    _write_job(dataset_root, state="running", step="starting", progress=0.0,
               dataset_id=dataset_id, run_name=run_name, sample_rate=sample_rate,
               started_at=datetime.now(timezone.utc).isoformat())
    try:
        stats = run_ingest(dataset_root, staging_dir, sample_rate=sample_rate,
                           run_name=run_name,
                           progress=_Progress(Path(dataset_root)), **opts)
        shutil.rmtree(staging_dir, ignore_errors=True)
        _write_job(dataset_root, state="done", step="finished", progress=1.0,
                   stats=stats, finished_at=datetime.now(timezone.utc).isoformat())
    except Exception as exc:
        logger.exception("ingest job failed")
        _write_job(dataset_root, state="error", detail=f"{exc}",
                   trace=traceback.format_exc()[-2000:],
                   finished_at=datetime.now(timezone.utc).isoformat())


def start_ingest_thread(dataset_root, staging_dir, *,
                        sample_rate: float | None = None,
                        run_name: str | None = None, dataset_id=None,
                        **opts) -> None:
    """Queue an ingestion on a background thread; poll :func:`read_job`."""
    _write_job(dataset_root, state="running", step="queued", progress=0.0,
               dataset_id=dataset_id, run_name=run_name, sample_rate=sample_rate)
    threading.Thread(
        target=run_ingest_job,
        args=(dataset_root, staging_dir),
        kwargs=dict(sample_rate=sample_rate, run_name=run_name,
                    dataset_id=dataset_id, **opts),
        name=f"ingest-{dataset_id}",
        daemon=True,
    ).start()


# ─── CLI ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level="INFO", format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser(
        description="Build a synthetic.duckdb from raw MATSim outputs")
    ap.add_argument("--staging-dir", required=True,
                    help="directory holding the canonically named inputs")
    ap.add_argument("--out-dir", required=True,
                    help="dataset directory; synthetic.duckdb is written here")
    ap.add_argument("--sample-rate", type=float, default=None,
                    help="population share of the run (derived from the person "
                         "count when omitted)")
    ap.add_argument("--run-name", default=None)
    ap.add_argument("--scale-transit", action="store_true",
                    help="scale passenger counts (boardings, transfers, "
                         "pt_link_volumes) to the full population by "
                         "1/sample_rate, as docs/duckdb-format.md specifies. "
                         "Off by default: every deployed dataset ships raw "
                         "counts (scaled_to_full_population: false) and the "
                         "frontends don't compensate, so a scaled dataset "
                         "would sit 1/sample_rate above its siblings")
    ap.add_argument("--skip-transfers", action="store_true",
                    help="do not write stop_transfer_data_by_canton (the "
                         "dashboard's Transfer Matrix / Transfer Destinations "
                         "then have no data for this dataset)")
    ap.add_argument("--skip-plan-homes", action="store_true",
                    help="do not recover home coordinates for activity-less "
                         "persons from output_plans.xml.gz")
    args = ap.parse_args()

    result = run_ingest(
        args.out_dir, args.staging_dir,
        sample_rate=args.sample_rate, run_name=args.run_name,
        scale_transit=args.scale_transit,
        with_transfers=not args.skip_transfers,
        with_plan_homes=not args.skip_plan_homes,
    )
    print("done:", args.out_dir)
    for k, v in sorted(result.items()):
        print(f"  {k}: {v}")

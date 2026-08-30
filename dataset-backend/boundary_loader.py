"""Load the Swiss admin boundaries shipped with this service into ``hot_polygons`` rows.

The MATSim ingestion pipeline (``ingest.py``) needs the canton / bezirk /
gemeinde polygons that every zone-aware provider in the webmap backend reads
out of a dataset's own ``hot_polygons`` table. Rather than ask the uploader for
them, the three swissBOUNDARIES3D shapefile sets are baked into the image under
``dataset-backend/boundaries/`` (the prod Dockerfile stage does ``COPY . .``;
the dev overlay bind-mounts ``./dataset-backend:/app``), and this module turns
them into plain dicts:

    from boundary_loader import load_hot_polygons
    rows = load_hot_polygons()   # 26 cantons + 134 bezirke + 2162 gemeinden

Everything is read with DuckDB's ``spatial`` extension (``ST_Read`` opens a
shapefile directly) — no geopandas/fiona/shapely, none of which are in
``requirements.txt``. The extension is pre-installed in the image; locally the
first call installs it.

Conventions, verified 1:1 against the pipeline-built ``hot_polygons`` table of
dataset 7036833688 (ids, names and parent chains match exactly, 0 diffs):

  * ``polygon_id``   ``canton:<KANTONSNUM>`` / ``bezirk:<BEZIRKSNUM>`` /
                     ``gemeinde:<BFS_NUMMER>`` — the official BFS numbering
                     straight out of the shapefile attributes.
  * ``polygon_name`` the shapefile ``NAME`` verbatim (accented, UTF-8: the
                     ``.cpg`` sidecars declare UTF-8), e.g. "Zürich",
                     "Graubünden", "Genève".
  * ``parent_id``    gemeinde → ``bezirk:<BEZIRKSNUM>`` *when the shapefile has
                     one*, else NULL; bezirk → ``canton:<KANTONSNUM>``;
                     canton → NULL. 154 of the 2162 gemeinden have no bezirk —
                     the nine district-less cantons, the 11 Liechtenstein
                     communes, Büsingen (DE), Campione d'Italia (IT) and the
                     lake bodies (``OBJEKTART='Kantonsgebiet'``). Those keep a
                     NULL parent even when they *do* carry a KANTONSNUM; the
                     reference table does the same, so do not "fix" it by
                     falling back to the canton.
  * ``wkt``          LV95 / EPSG:2056, forced to 2D (the source geometries are
                     3D — CH1903+ LV95 + LN02 height).

The shapefiles are already dissolved to one row per unit (MULTIPOLYGON where a
unit is discontiguous), so no grouping is needed and every non-CH / lake /
Kommunanz object is kept: the reference row set includes them all.
"""

from __future__ import annotations

import logging
import unicodedata
from pathlib import Path
from typing import Any, NamedTuple

import duckdb

logger = logging.getLogger(__name__)

BOUNDARY_DIR = Path(__file__).parent / "boundaries"


# Canonical canton numbering, copied as a literal from
# ``webmap-backend/providers/constants.py::CANTON_MAP`` — cross-package imports
# are forbidden (each service builds its own Docker image). Used only to
# sanity-check the shapefile's KANTONSNUM: the swissBOUNDARIES3D attribute *is*
# the official BFS numbering and it matches this map 1:1 (Zurich=1 … Jura=26),
# so ids are taken from the shapefile and this is a tripwire, not a lookup.
CANTON_MAP: dict[int, str] = {
    1: "Zurich",
    2: "Bern",
    3: "Luzern",
    4: "Uri",
    5: "Schwyz",
    6: "Obwalden",
    7: "Nidwalden",
    8: "Glarus",
    9: "Zug",
    10: "Fribourg",
    11: "Solothurn",
    12: "Basel-Stadt",
    13: "Basel-Landschaft",
    14: "Schaffhausen",
    15: "AppenzellAusserrhoden",
    16: "AppenzellInnerrhoden",
    17: "StGallen",
    18: "Graubunden",
    19: "Aargau",
    20: "Thurgau",
    21: "Ticino",
    22: "Vaud",
    23: "Valais",
    24: "Neuchatel",
    25: "Geneve",
    26: "Jura",
}


class _Level(NamedTuple):
    """One admin level: where its shapefile is and how to derive id/parent."""

    polygon_type: str
    shp: Path
    id_col: str
    parent_expr: str  # SQL producing the parent polygon_id (or NULL)
    expected: int  # row count in the reference dataset, for a log-level check


_LEVELS: tuple[_Level, ...] = (
    _Level(
        "canton",
        BOUNDARY_DIR / "canton" / "swissBOUNDARIES3D_1_5_TLM_KANTONSGEBIET.shp",
        "KANTONSNUM",
        "NULL",
        26,
    ),
    _Level(
        "bezirk",
        BOUNDARY_DIR / "districts" / "swissBOUNDARIES3D_1_5_TLM_BEZIRKSGEBIET.shp",
        "BEZIRKSNUM",
        "'canton:' || CAST(KANTONSNUM AS VARCHAR)",
        134,
    ),
    _Level(
        "gemeinde",
        BOUNDARY_DIR / "municipalities" / "swissBOUNDARIES3D_1_5_TLM_HOHEITSGEBIET.shp",
        "BFS_NUMMER",
        "CASE WHEN BEZIRKSNUM IS NULL THEN NULL "
        "ELSE 'bezirk:' || CAST(BEZIRKSNUM AS VARCHAR) END",
        2162,
    ),
)


def _connect() -> duckdb.DuckDBPyConnection:
    """In-memory DuckDB with the spatial extension loaded."""
    con = duckdb.connect()
    try:
        con.execute("LOAD spatial")
    except duckdb.Error:  # not pre-installed (local dev) — fetch it once
        logger.info("boundary_loader: installing DuckDB spatial extension")
        con.execute("INSTALL spatial")
        con.execute("LOAD spatial")
    return con


def _read_level(con: duckdb.DuckDBPyConnection, level: _Level) -> list[dict[str, Any]]:
    """Read one shapefile into ``hot_polygons``-shaped dicts."""
    if not level.shp.exists():
        raise FileNotFoundError(
            f"boundary shapefile missing: {level.shp} — the {level.polygon_type} "
            f"set must be present under {BOUNDARY_DIR}"
        )

    sql = f"""
        SELECT '{level.polygon_type}:' || CAST({level.id_col} AS VARCHAR) AS polygon_id,
               '{level.polygon_type}'                                     AS polygon_type,
               NAME                                                       AS polygon_name,
               {level.parent_expr}                                        AS parent_id,
               ST_AsText(ST_Force2D(geom))                                AS wkt
        FROM ST_Read(?)
        WHERE {level.id_col} IS NOT NULL
        ORDER BY {level.id_col}
    """
    cur = con.execute(sql, [str(level.shp)])
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    if len(rows) != level.expected:
        logger.warning(
            "boundary_loader: %s has %d polygons, expected %d (shapefile vintage "
            "changed?)",
            level.polygon_type,
            len(rows),
            level.expected,
        )
    return rows


def _fold(name: str) -> str:
    """ASCII-fold a canton name for comparison.

    CANTON_MAP is ASCII and space-free ("StGallen", "Graubunden"); the
    shapefile spells the display form ("St. Gallen", "Graubünden").
    """
    norm = unicodedata.normalize("NFKD", name)
    return "".join(c for c in norm if c.isalnum()).lower()


def _check_canton_numbering(rows: list[dict[str, Any]]) -> None:
    """Warn if the shapefile's KANTONSNUM drifts from the canonical CANTON_MAP."""
    if len(rows) != len(CANTON_MAP):
        logger.warning(
            "boundary_loader: %d cantons in the shapefile, CANTON_MAP has %d",
            len(rows),
            len(CANTON_MAP),
        )
        return

    for row in rows:
        cid = int(row["polygon_id"].split(":", 1)[1])
        expected = CANTON_MAP.get(cid)
        if expected is None or _fold(expected) != _fold(row["polygon_name"]):
            logger.warning(
                "boundary_loader: canton %d is %r in the shapefile but %r in "
                "CANTON_MAP — the BFS numbering no longer matches constants.py",
                cid,
                row["polygon_name"],
                expected,
            )


def load_hot_polygons() -> list[dict]:
    """Return every Swiss admin polygon as a ``hot_polygons`` row.

    Each dict has ``polygon_id``, ``polygon_type`` ("canton" | "bezirk" |
    "gemeinde"), ``polygon_name``, ``parent_id`` (``str | None``) and ``wkt``
    (2D LV95 / EPSG:2056 POLYGON or MULTIPOLYGON text). Ordered canton →
    bezirk → gemeinde, by numeric id within each level.
    """
    con = _connect()
    try:
        rows: list[dict[str, Any]] = []
        for level in _LEVELS:
            level_rows = _read_level(con, level)
            if level.polygon_type == "canton":
                _check_canton_numbering(level_rows)
            logger.info(
                "boundary_loader: loaded %d %s polygons from %s",
                len(level_rows),
                level.polygon_type,
                level.shp.name,
            )
            rows.extend(level_rows)
    finally:
        con.close()

    logger.info("boundary_loader: %d hot_polygons rows total", len(rows))
    return rows


if __name__ == "__main__":  # pragma: no cover - manual smoke check
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    all_rows = load_hot_polygons()
    by_type: dict[str, int] = {}
    for r in all_rows:
        by_type[r["polygon_type"]] = by_type.get(r["polygon_type"], 0) + 1
    print(by_type)
    print(all_rows[0]["polygon_id"], all_rows[0]["polygon_name"],
          all_rows[0]["wkt"][:60])

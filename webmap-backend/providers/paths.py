"""Resolves dataset roots and locates the per-source DuckDB files.

After the v1 schema migration, every dataset directory contains:

    <root>/synthetic.duckdb
    <root>/microcensus.duckdb
    <root>/json_preview/   (precomputed static .geojson / .json)

The webmap backend opens the duckdb files read-only and queries them
directly. Both duckdb files are optional — ``has_synthetic``/``has_microcensus``
reflect what's actually present. A handful of static GeoJSON/JSON assets
(municipalities, stop-municipality lookup) still live under
``json_preview/`` and are read straight from disk by the providers that
have not yet been folded into duckdb.

Two modes:
  1. Global: WEBMAP_ROOT env var → all requests use the same dataset root.
  2. Per-request: the backend sets a ContextVar override per request via the
     dataset service (see base.py).
"""

import os
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

# Per-request root override (async-safe)
_root_override: ContextVar[str | None] = ContextVar("_root_override", default=None)


def set_root_override(root: str | None) -> None:
    """Set a per-request dataset root override. Call with None to clear."""
    _root_override.set(root)


@dataclass(frozen=True)
class DataPaths:
    root: str
    synthetic_db: str
    microcensus_db: str
    json_preview_dir: str
    # Legacy parquet/duckdb layout — used by providers that haven't been
    # folded into the two-duckdb-file design (link_speeds, zone_flows).
    synthetic_dir: str
    synthetic_output_trips: str
    spider_db: str
    link_speeds: str

    @property
    def has_synthetic(self) -> bool:
        return Path(self.synthetic_db).exists()

    @property
    def has_microcensus(self) -> bool:
        return Path(self.microcensus_db).exists()


def get_data_paths() -> DataPaths:
    """Resolve the dataset root from per-request override or WEBMAP_ROOT."""
    root = _root_override.get() or os.getenv("WEBMAP_ROOT")
    if not root:
        raise RuntimeError(
            "No dataset root resolved and WEBMAP_ROOT is not set. "
            "Use /data/{dataset_id}/… or set the WEBMAP_ROOT env var."
        )
    root_p = Path(root)
    syn = root_p / "synthetic"
    return DataPaths(
        root=str(root_p),
        synthetic_db=str(root_p / "synthetic.duckdb"),
        microcensus_db=str(root_p / "microcensus.duckdb"),
        json_preview_dir=str(root_p / "json_preview"),
        synthetic_dir=str(syn),
        synthetic_output_trips=str(syn / "output_trips.parquet"),
        spider_db=str(syn / "spider.duckdb"),
        link_speeds=str(syn / "link_speeds.parquet"),
    )


def db_path_for_source(source: str) -> str:
    """Return the absolute DuckDB path for a source label.

    Args:
        source: 'synthetic' or 'microcensus' (case-insensitive).
    """
    paths = get_data_paths()
    s = source.lower()
    if s in ("synthetic", "syn"):
        return paths.synthetic_db
    if s in ("microcensus", "mc"):
        return paths.microcensus_db
    raise ValueError(f"unknown source: {source!r}")

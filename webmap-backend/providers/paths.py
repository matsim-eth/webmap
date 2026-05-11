"""Resolves dataset roots and locates the per-source DuckDB files.

After the v1 schema migration, every dataset directory contains exactly two
files:

    <root>/synthetic.duckdb
    <root>/microcensus.duckdb

The webmap backend opens these read-only and queries them directly; there are
no parquets, no XML, no auxiliary files anymore. Both files are optional —
``has_synthetic``/``has_microcensus`` reflect what's actually present.

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
    return DataPaths(
        root=str(root_p),
        synthetic_db=str(root_p / "synthetic.duckdb"),
        microcensus_db=str(root_p / "microcensus.duckdb"),
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

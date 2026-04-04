"""Central path configuration for all data sources.

Supports two modes:
  1. Global: Set WEBMAP_ROOT env var → all requests use the same data directory.
  2. Per-dataset: The webmap backend sets a ContextVar override per request,
     resolved via the dataset service. Providers call get_data_paths() as
     before — the override is transparent.

Example layout (per dataset):
    $ROOT/
    ├── synthetic/
    │   ├── switzerland_persons.parquet
    │   ├── households.parquet
    │   ├── trips.parquet
    │   ├── activities.parquet
    │   ├── output_trips.parquet
    │   └── spider.duckdb
    ├── microcensus/
    │   ├── persons.parquet
    │   ├── households.parquet
    │   └── trips.parquet
    └── json_preview/
        └── *.json, *.geojson
"""

import os
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

# Per-request root override (async-safe, scoped per coroutine)
_root_override: ContextVar[str | None] = ContextVar("_root_override", default=None)


def set_root_override(root: str | None) -> None:
    """Set a per-request dataset root override. Call with None to clear."""
    _root_override.set(root)


@dataclass(frozen=True)
class DataPaths:
    synthetic_persons: str
    synthetic_households: str
    synthetic_trips: str
    synthetic_activities: str
    synthetic_output_trips: str
    microcensus_persons: str
    microcensus_households: str
    microcensus_trips: str
    json_preview_dir: str
    spider_db: str
    network_xml: str
    link_speeds: str


def get_data_paths() -> DataPaths:
    """Build DataPaths from the per-request override or WEBMAP_ROOT env var.

    Priority: ContextVar override > WEBMAP_ROOT environment variable.
    Raises RuntimeError if neither is available.
    """
    root = _root_override.get() or os.getenv("WEBMAP_ROOT")
    if not root:
        raise RuntimeError(
            "No dataset root resolved and WEBMAP_ROOT is not set. "
            "Use /data/{dataset_id}/… or set the WEBMAP_ROOT env var."
        )
    s = Path(root) / "synthetic"
    m = Path(root) / "microcensus"
    j = Path(root) / "json_preview"
    return DataPaths(
        synthetic_persons=str(s / "switzerland_persons.parquet"),
        synthetic_households=str(s / "households.parquet"),
        synthetic_trips=str(s / "trips.parquet"),
        synthetic_activities=str(s / "activities.parquet"),
        synthetic_output_trips=str(s / "output_trips.parquet"),
        microcensus_persons=str(m / "persons.parquet"),
        microcensus_households=str(m / "households.parquet"),
        microcensus_trips=str(m / "trips.parquet"),
        json_preview_dir=str(j),
        spider_db=str(s / "spider.duckdb"),
        network_xml=str(s / "switzerland_network.xml"),
        link_speeds=str(s / "link_speeds.parquet"),
    )

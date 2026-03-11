"""Central path configuration for all data sources.

Set the WEBMAP_ROOT environment variable to the directory that contains
the 'synthetic/' and 'microcensus/' subdirectories.

Example layout:
    $WEBMAP_ROOT/
    ├── synthetic/
    │   ├── persons.parquet
    │   ├── households.parquet
    │   └── trips.parquet
    └── microcensus/
        ├── persons.parquet
        ├── households.parquet
        └── trips.parquet
"""

import os
from dataclasses import dataclass
from pathlib import Path


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


def get_data_paths() -> DataPaths:
    """Build DataPaths from the WEBMAP_ROOT environment variable.

    Raises RuntimeError if WEBMAP_ROOT is not set.
    """
    root = os.getenv("WEBMAP_ROOT")
    if not root:
        raise RuntimeError(
            "WEBMAP_ROOT environment variable is not set. "
            "Point it to the directory containing synthetic/ and microcensus/."
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
    )

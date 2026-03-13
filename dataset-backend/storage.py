"""Filesystem operations for dataset storage."""

import os
import re
import shutil
from pathlib import Path

DATASET_STORAGE_ROOT = os.getenv("DATASET_STORAGE_ROOT", "/data/datasets")

# Expected files per category
EXPECTED_FILES = {
    "synthetic": {
        "switzerland_persons.parquet",
        "households.parquet",
        "trips.parquet",
        "activities.parquet",
        "output_trips.parquet",
        "spider.duckdb",
    },
    "microcensus": {
        "persons.parquet",
        "households.parquet",
        "trips.parquet",
    },
}

# Allowed extensions per category
ALLOWED_EXTENSIONS = {
    "synthetic": {".parquet", ".duckdb"},
    "microcensus": {".parquet"},
}


def slugify(name: str) -> str:
    """Convert a dataset name to a filesystem-safe slug."""
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9_\-]", "_", slug)
    slug = re.sub(r"_+", "_", slug).strip("_")
    return slug or "dataset"


def dataset_root(owner_id: int, dataset_id: int, is_public: bool = False) -> Path:
    """Return the root directory for a dataset.

    Public datasets live at STORAGE_ROOT/public/{dataset_id}/
    User datasets live at STORAGE_ROOT/{owner_id}/{dataset_id}/
    """
    if is_public:
        return Path(DATASET_STORAGE_ROOT) / "public" / str(dataset_id)
    return Path(DATASET_STORAGE_ROOT) / str(owner_id) / str(dataset_id)


def create_dataset_dirs(owner_id: int, dataset_id: int, is_public: bool = False) -> Path:
    """Create the directory structure for a new dataset. Returns root path."""
    root = dataset_root(owner_id, dataset_id, is_public)
    (root / "synthetic").mkdir(parents=True, exist_ok=True)
    (root / "microcensus").mkdir(parents=True, exist_ok=True)
    return root


def delete_dataset_dirs(owner_id: int, dataset_id: int, is_public: bool = False) -> None:
    """Remove the entire dataset directory tree."""
    root = dataset_root(owner_id, dataset_id, is_public)
    if root.exists():
        shutil.rmtree(root)


def list_files(owner_id: int, dataset_id: int, category: str, is_public: bool = False) -> list[str]:
    """List files in a dataset category directory."""
    cat_dir = dataset_root(owner_id, dataset_id, is_public) / category
    if not cat_dir.exists():
        return []
    return sorted(f.name for f in cat_dir.iterdir() if f.is_file())


def validate_filename(filename: str, category: str) -> bool:
    """Check if a filename is allowed for the given category."""
    safe_name = Path(filename).name  # strip any path components
    if safe_name != filename:
        return False  # path traversal attempt
    if ".." in filename:
        return False
    ext = Path(filename).suffix.lower()
    allowed = ALLOWED_EXTENSIONS.get(category, set())
    return ext in allowed


def check_dataset_completeness(owner_id: int, dataset_id: int, is_public: bool = False) -> dict[str, bool]:
    """Check which data categories are populated."""
    root = dataset_root(owner_id, dataset_id, is_public)
    syn_dir = root / "synthetic"
    mc_dir = root / "microcensus"

    has_synthetic = syn_dir.exists() and any(syn_dir.iterdir())
    has_microcensus = mc_dir.exists() and any(mc_dir.iterdir())
    has_spider_db = (syn_dir / "spider.duckdb").exists()

    return {
        "has_synthetic": has_synthetic,
        "has_microcensus": has_microcensus,
        "has_spider_db": has_spider_db,
    }

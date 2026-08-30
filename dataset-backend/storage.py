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
    "microcensus": {".parquet", ".duckdb"},
}

# v2 layout: each source is a single DuckDB file at the dataset root
# (<root>/synthetic.duckdb, <root>/microcensus.duckdb).
DUCKDB_CATEGORIES = ("synthetic", "microcensus")


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
    """Create an empty root directory for a new dataset. Returns root path.

    The per-source DuckDB files (``synthetic.duckdb`` / ``microcensus.duckdb``)
    are uploaded into this directory afterwards — we no longer pre-create the
    legacy ``synthetic/`` and ``microcensus/`` subfolders.
    """
    root = dataset_root(owner_id, dataset_id, is_public)
    root.mkdir(parents=True, exist_ok=True)
    return root


def duckdb_path(owner_id: int, dataset_id: int, category: str, is_public: bool = False) -> Path:
    """Return the destination path for a source's DuckDB file at the dataset root."""
    return dataset_root(owner_id, dataset_id, is_public) / f"{category}.duckdb"


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
    """Check which data categories are populated.

    Recognises both layouts: the v2 per-source DuckDB files at the root
    (``synthetic.duckdb`` / ``microcensus.duckdb``) and the legacy v1
    subdirectories (``synthetic/`` / ``microcensus/``).
    """
    root = dataset_root(owner_id, dataset_id, is_public)
    syn_db = root / "synthetic.duckdb"
    mc_db = root / "microcensus.duckdb"
    syn_dir = root / "synthetic"
    mc_dir = root / "microcensus"
    jp_dir = root / "json_preview"

    has_synthetic = syn_db.exists() or (syn_dir.exists() and any(syn_dir.iterdir()))
    has_microcensus = mc_db.exists() or (mc_dir.exists() and any(mc_dir.iterdir()))
    has_spider_db = syn_db.exists() or (syn_dir / "spider.duckdb").exists()
    has_json_preview = jp_dir.exists() and any(jp_dir.iterdir())

    return {
        "has_synthetic": has_synthetic,
        "has_microcensus": has_microcensus,
        "has_spider_db": has_spider_db,
        "has_json_preview": has_json_preview,
    }


# Folders to exclude from data category listing
_IGNORE_DIRS = {"json_preview", "__pycache__", "_ingest_staging", "_ingest_tmp"}


def list_data_categories(owner_id: int, dataset_id: int, is_public: bool = False) -> list[str]:
    """Return the data categories of a dataset (e.g. ['microcensus', 'synthetic']).

    Recognises both layouts:
      * v1: non-empty subdirectories named after the category (``synthetic/``)
      * v2: per-category DuckDB files (``synthetic.duckdb``)
    """
    root = dataset_root(owner_id, dataset_id, is_public)
    if not root.exists():
        return []
    cats: set[str] = set()
    for entry in root.iterdir():
        if entry.is_dir() and entry.name not in _IGNORE_DIRS and any(entry.iterdir()):
            cats.add(entry.name)
        elif entry.is_file() and entry.suffix == ".duckdb":
            cats.add(entry.stem)  # 'synthetic.duckdb' -> 'synthetic'
    return sorted(cats)

"""Pydantic request/response schemas for the dataset service."""

from datetime import datetime

from pydantic import BaseModel, Field


# ── Request schemas ──────────────────────────────────────────────

class DatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None


class DatasetUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None


class AdminDatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    owner_id: int
    owner_username: str = "unknown"
    is_public: bool = False


class AdminDatasetUpdate(BaseModel):
    id: int | None = None  # Change the dataset ID
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    status: str | None = None  # "active" or "inactive"
    is_public: bool | None = None


class DefaultDatasetIn(BaseModel):
    """Set (or clear) the system-wide default dataset.

    A dedicated endpoint rather than a field on AdminDatasetUpdate because the
    operation is inherently *exclusive* — setting one default clears the other —
    so it can't be expressed as an independent per-dataset field without making
    "is_default: false" ambiguous (clear this one? or clear everything?)."""

    # Required but nullable: an explicit `null` clears the default, while an
    # empty body is a 422 rather than a silent clear. Without `Field(...)` a
    # client that dropped the field would wipe the system default and get a 200.
    dataset_id: int | None = Field(...)


class RezoneIn(BaseModel):
    """Re-zone request: derive a NEW dataset whose primary zones are
    ``zone_type`` polygons (already present in the source duckdb's
    hot_polygons), optionally filtered to one canton."""
    zone_type: str = Field(pattern="^(gemeinde|bezirk)$")
    canton_id: int | None = None  # None = keep the whole study area
    name: str | None = Field(None, min_length=1, max_length=255)


# ── Response schemas ─────────────────────────────────────────────

class DatasetOut(BaseModel):
    id: int
    name: str
    slug: str
    description: str | None
    owner_id: int
    owner_username: str
    status: str
    is_public: bool
    is_default: bool = False
    has_synthetic: bool
    has_microcensus: bool
    has_json_preview: bool
    has_spider_db: bool
    data_categories: list[str] = []
    created_at: datetime
    updated_at: datetime


class DatasetListOut(BaseModel):
    datasets: list[DatasetOut]


class DatasetResolveOut(BaseModel):
    dataset_id: int
    root_path: str
    has_synthetic: bool
    has_microcensus: bool
    has_json_preview: bool
    has_spider_db: bool


class FileListOut(BaseModel):
    category: str
    files: list[str]


class GrantIn(BaseModel):
    user_id: int
    role: str = "viewer"  # viewer | editor


class GrantOut(BaseModel):
    user_id: int
    role: str
    granted_by: int
    created_at: datetime

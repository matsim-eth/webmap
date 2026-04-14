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

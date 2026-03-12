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


class AdminDatasetUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    status: str | None = None
    is_public: bool | None = None


class PermissionGrant(BaseModel):
    user_id: int
    user_email: str | None = None
    level: str = "read"  # "read" or "write"


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
    created_at: datetime
    updated_at: datetime
    permission_level: str  # "owner", "read", "write"


class DatasetListOut(BaseModel):
    datasets: list[DatasetOut]


class PermissionOut(BaseModel):
    id: int
    dataset_id: int
    user_id: int
    user_email: str | None
    level: str
    granted_at: datetime
    granted_by: int


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

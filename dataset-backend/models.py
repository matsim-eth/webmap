"""SQLAlchemy models for the dataset service."""

import enum
import random
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Boolean,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


def _generate_dataset_id() -> int:
    """Generate a random 10-digit dataset ID."""
    return random.randint(1_000_000_000, 9_999_999_999)


class DatasetStatus(str, enum.Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class Dataset(Base):
    __tablename__ = "datasets"

    id = Column(BigInteger, primary_key=True, default=_generate_dataset_id)
    name = Column(String(255), nullable=False)
    slug = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    owner_id = Column(Integer, nullable=False, index=True)
    owner_username = Column(String(255), nullable=False)
    status = Column(String(20), default="inactive", nullable=False)
    has_synthetic = Column(Boolean, default=False, nullable=False)
    has_microcensus = Column(Boolean, default=False, nullable=False)
    has_json_preview = Column(Boolean, default=False, nullable=False)
    has_spider_db = Column(Boolean, default=False, nullable=False)
    is_public = Column(Boolean, default=False, server_default="false", nullable=False)
    # The system-wide default dataset: what both frontends open on a fresh load
    # and what the webmap backend prewarms first. At most one row may be true —
    # enforced by the partial unique index created in main.py's lifespan, so a
    # concurrent double-set fails loudly instead of leaving two defaults for the
    # frontends to pick between. Admin-managed via PUT /admin/datasets/default.
    is_default = Column(Boolean, default=False, server_default="false", nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        UniqueConstraint("owner_id", "slug", name="uq_owner_slug"),
    )


class DatasetGrant(Base):
    """Per-user access to a private dataset.

    Roles:
      viewer — may resolve/read the dataset (maps + dashboard)
      editor — may additionally upload/replace the dataset's files
    Owners implicitly hold every right; public datasets need no grants.
    """

    __tablename__ = "dataset_grants"

    id = Column(Integer, primary_key=True, autoincrement=True)
    dataset_id = Column(BigInteger, ForeignKey("datasets.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    role = Column(String(20), default="viewer", nullable=False)  # viewer | editor
    granted_by = Column(Integer, nullable=False)                  # admin/owner user id
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        UniqueConstraint("dataset_id", "user_id", name="uq_dataset_user_grant"),
    )

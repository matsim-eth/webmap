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
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        UniqueConstraint("owner_id", "slug", name="uq_owner_slug"),
    )

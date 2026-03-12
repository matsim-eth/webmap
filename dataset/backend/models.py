"""SQLAlchemy models for the dataset service."""

import enum
import random
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Boolean,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


def _generate_dataset_id() -> int:
    """Generate a random 10-digit dataset ID."""
    return random.randint(1_000_000_000, 9_999_999_999)


class DatasetStatus(str, enum.Enum):
    PENDING = "pending"
    READY = "ready"
    ERROR = "error"


class PermissionLevel(str, enum.Enum):
    READ = "read"
    WRITE = "write"


# Fixed ID for the built-in public demo dataset
PUBLIC_DEMO_ID = 1_000_000_001


class Dataset(Base):
    __tablename__ = "datasets"

    id = Column(BigInteger, primary_key=True, default=_generate_dataset_id)
    name = Column(String(255), nullable=False)
    slug = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    owner_id = Column(Integer, nullable=False, index=True)
    owner_username = Column(String(255), nullable=False)
    status = Column(SAEnum(DatasetStatus), default=DatasetStatus.PENDING, nullable=False)
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

    permissions = relationship(
        "DatasetPermission", back_populates="dataset", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("owner_id", "slug", name="uq_owner_slug"),
    )


class DatasetPermission(Base):
    __tablename__ = "dataset_permissions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    dataset_id = Column(
        BigInteger, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False
    )
    user_id = Column(Integer, nullable=False)
    user_email = Column(String(255), nullable=True)
    level = Column(SAEnum(PermissionLevel), default=PermissionLevel.READ, nullable=False)
    granted_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    granted_by = Column(Integer, nullable=False)

    dataset = relationship("Dataset", back_populates="permissions")

    __table_args__ = (
        UniqueConstraint("dataset_id", "user_id", name="uq_dataset_user"),
        Index("ix_perm_user_id", "user_id"),
    )

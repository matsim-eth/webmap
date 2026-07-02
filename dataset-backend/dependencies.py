"""Auth dependencies and access checks for the dataset service."""

import os
from typing import AsyncGenerator

from AuthAPI import RequireUser
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from models import Dataset, DatasetGrant

# ── Database ─────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+asyncpg://dataset_user:dataset_pass@dataset_database:5432/datasetdb")

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


# ── Access checks ────────────────────────────────────────────────
#
# Access model:
#   public dataset            → readable by every authenticated user
#   owner                     → full control (read, write, share)
#   grant role 'viewer'       → read (resolve/list/files)
#   grant role 'editor'       → read + write (upload/replace files)
#   admins (JWT admin claim)  → full control over everything


def _is_admin(user) -> bool:
    return bool(getattr(user, "admin", False))


async def _grant_role(db: AsyncSession, dataset_id: int, user_id: int) -> str | None:
    g = await db.scalar(select(DatasetGrant).where(
        DatasetGrant.dataset_id == dataset_id, DatasetGrant.user_id == user_id))
    return g.role if g else None


async def require_dataset_access(
    dataset_id: int,
    db: AsyncSession,
    user,
) -> Dataset:
    """Read access: public, owner, admin, or any grant (viewer/editor)."""
    dataset = await db.get(Dataset, dataset_id)
    if not dataset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dataset not found")

    # Block access to inactive datasets (admins may still see them)
    ds_status = dataset.status.value if hasattr(dataset.status, "value") else dataset.status
    if ds_status == "inactive" and not _is_admin(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="dataset inactive")

    if dataset.is_public or dataset.owner_id == user.id or _is_admin(user):
        return dataset

    if await _grant_role(db, dataset_id, user.id) is not None:
        return dataset

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="access denied")


async def require_dataset_write(
    dataset_id: int,
    db: AsyncSession,
    user,
) -> Dataset:
    """Write access (upload/replace files): owner, admin, or 'editor' grant."""
    dataset = await require_dataset_access(dataset_id, db, user)
    if dataset.owner_id == user.id or _is_admin(user):
        return dataset
    if await _grant_role(db, dataset_id, user.id) == "editor":
        return dataset
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="write access denied")


async def require_dataset_manage(
    dataset_id: int,
    db: AsyncSession,
    user,
) -> Dataset:
    """Manage access (sharing/grants): owner or admin only."""
    dataset = await db.get(Dataset, dataset_id)
    if not dataset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dataset not found")
    if dataset.owner_id == user.id or _is_admin(user):
        return dataset
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="only the owner or an admin can manage access")

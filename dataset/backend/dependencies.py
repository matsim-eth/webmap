"""Auth dependencies and permission checks for the dataset service."""

import os
from typing import AsyncGenerator

from AuthAPI import decode_token
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from models import Dataset, DatasetPermission, PermissionLevel

# ── Database ─────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+asyncpg://dataset_user:dataset_pass@dataset_database:5432/datasetdb")

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


# ── Auth ─────────────────────────────────────────────────────────

async def get_current_user(request: Request) -> dict:
    """Decode JWT from access_token cookie. Returns claims dict."""
    token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        claims = decode_token(token)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    return claims


def _user_id(user: dict) -> int:
    """Extract user ID from decoded JWT payload."""
    return int(user.get("sub") or user.get("id") or 0)


def _username(user: dict) -> str:
    """Extract username from decoded JWT payload."""
    return str(user.get("username") or user.get("email") or "unknown")


# ── Permission checks ────────────────────────────────────────────

async def require_dataset_access(
    dataset_id: int,
    db: AsyncSession,
    user: dict,
    require_write: bool = False,
) -> tuple[Dataset, str]:
    """Fetch a dataset and verify the user has access.

    Returns (dataset, permission_level) where permission_level is "owner", "read", or "write".
    Raises 404 if not found, 403 if no access.
    """
    dataset = await db.get(Dataset, dataset_id)
    if not dataset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dataset not found")

    uid = _user_id(user)

    # Public datasets are accessible by everyone (read-only unless owner)
    if dataset.is_public:
        if dataset.owner_id == uid:
            return dataset, "owner"
        if require_write:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="write access required")
        return dataset, "read"

    # Owner always has full access
    if dataset.owner_id == uid:
        return dataset, "owner"

    # Check permissions table
    perm = await db.scalar(
        select(DatasetPermission).where(
            DatasetPermission.dataset_id == dataset_id,
            DatasetPermission.user_id == uid,
        )
    )

    if not perm:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="access denied")

    if require_write and perm.level != PermissionLevel.WRITE:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="write access required")

    return dataset, perm.level.value

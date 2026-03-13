"""Auth dependencies and access checks for the dataset service."""

import os
from typing import AsyncGenerator

from AuthAPI import RequireUser
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from models import Dataset

# ── Database ─────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+asyncpg://dataset_user:dataset_pass@dataset_database:5432/datasetdb")

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


# ── Access check ─────────────────────────────────────────────────

async def require_dataset_access(
    dataset_id: int,
    db: AsyncSession,
    user,
) -> Dataset:
    dataset = await db.get(Dataset, dataset_id)
    if not dataset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dataset not found")

    # Block access to inactive datasets
    ds_status = dataset.status.value if hasattr(dataset.status, "value") else dataset.status
    if ds_status == "inactive":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="dataset inactive")

    # Public datasets are accessible by everyone
    if dataset.is_public:
        return dataset

    # Private datasets: only owner
    if dataset.owner_id == user.id:
        return dataset

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="access denied")

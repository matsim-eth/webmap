"""Broker persistence — lives in the existing dataset Postgres instance
(own tables, ``sim_`` prefix). SQLite via aiosqlite works for tests.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from sqlalchemy import (JSON, Boolean, DateTime, Float, Integer, String, Text)
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://dataset_user:dataset_pass@dataset_database:5432/datasetdb",
)

engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SimScenario(Base):
    """Registry: which base datasets have a runnable input bundle, and
    where it lives on the worker machine. Admin-managed."""
    __tablename__ = "sim_scenarios"

    dataset_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bundle_path: Mapped[str] = mapped_column(String(1024))   # worker-local dir
    config_name: Mapped[str] = mapped_column(String(255),
                                             default="switzerland_config.xml")
    jar_path: Mapped[str] = mapped_column(String(1024))      # eqasim jar (worker-local)
    java_memory: Mapped[str] = mapped_column(String(16), default="64G")
    threads: Mapped[int] = mapped_column(Integer, default=16)
    minutes_per_iteration: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Population share of the base run (0.01 = 1 %). Passed to the dataset
    # ingest so the result is scaled like its base; derived from the person
    # count when unset.
    sample_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=_now)


class SimJob(Base):
    """One custom run through its whole lifecycle:

        proposed → queued → running → uploading → done
                          ↘ failed / cancelled
    """
    __tablename__ = "sim_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    username: Mapped[str] = mapped_column(String(255), default="")
    title: Mapped[str] = mapped_column(String(255))
    # Plain-language summary written by the proposing agent/user: what the
    # scenario changes and what question it answers. Shown in every job UI
    # and becomes the result dataset's description.
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(32), default="proposed", index=True)

    base_dataset_id: Mapped[int] = mapped_column(Integer)
    diff: Mapped[dict] = mapped_column(JSON)                 # validated ScenarioDiff
    summary: Mapped[list] = mapped_column(JSON, default=list)
    estimate: Mapped[str] = mapped_column(String(255), default="")

    phase: Mapped[str] = mapped_column(String(64), default="")
    progress: Mapped[float] = mapped_column(Float, default=0.0)   # 0..1
    message: Mapped[str] = mapped_column(String(512), default="")
    log_tail: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(Text, default="")

    worker_id: Mapped[str] = mapped_column(String(128), default="")
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    result_dataset_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Resume: a job re-queued from a cancelled/failed one. The worker that ran
    # the original still holds its workdir, so it is offered the job first
    # and continues from the last written iteration instead of restarting.
    resume_of: Mapped[int | None] = mapped_column(Integer, nullable=True)
    preferred_worker: Mapped[str] = mapped_column(String(128), default="")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=_now)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                          nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                        nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                         nullable=True)


# Columns added after the first deployment. create_all never alters existing
# tables, so each is applied as a plain ADD COLUMN; "already exists" errors
# (any dialect) are the normal case on every later start.
_ADDED_COLUMNS = (
    ("sim_scenarios", "sample_rate", "FLOAT"),
    ("sim_jobs", "description", "TEXT DEFAULT ''"),
    ("sim_jobs", "resume_of", "INTEGER"),
    ("sim_jobs", "preferred_worker", "VARCHAR(128) DEFAULT ''"),
)


async def create_tables() -> None:
    from sqlalchemy import text
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    for table, column, ddl in _ADDED_COLUMNS:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(
                    f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
        except Exception:
            pass

"""Internal dataset endpoints — service-to-service, not routed by Nginx."""

import hmac
import logging
import os
import shutil
from pathlib import Path

from AuthAPI import RequireUser
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_db, require_dataset_access
from models import Dataset
from schemas import DatasetResolveOut
from storage import dataset_root, delete_dataset_dirs

logger = logging.getLogger(__name__)

DATASET_STORAGE_ROOT = os.getenv("DATASET_STORAGE_ROOT", "/data/datasets")

# Shared secret for the unauthenticated /internal/* endpoints. The proxy already
# 404s this subtree from the edge; this is defense-in-depth so a proxy
# misconfiguration can't silently re-expose destructive operations (init/delete
# user storage). Callers (auth-backend) send it in the X-Internal-Secret header.
INTERNAL_SERVICE_SECRET = os.getenv("INTERNAL_SERVICE_SECRET", "").strip()
if not INTERNAL_SERVICE_SECRET:
    logger.warning("INTERNAL_SERVICE_SECRET is unset — /internal/* relies on "
                   "proxy/network isolation only. Set it in .env.")


async def require_internal_secret(
    x_internal_secret: str | None = Header(None, alias="X-Internal-Secret"),
) -> None:
    """Reject internal calls that don't carry the shared secret.

    When ``INTERNAL_SERVICE_SECRET`` is unset we fall back to relying on the
    proxy/network isolation (warned once at import), so existing deployments
    keep working; set it in the shared .env to enable the check on every
    service. Responds 404 (not 403) so the endpoints don't confirm they exist.
    """
    if not INTERNAL_SERVICE_SECRET:
        return
    # Compare as bytes: Starlette decodes headers as latin-1, and
    # hmac.compare_digest raises TypeError on non-ASCII str input.
    supplied = (x_internal_secret or "").encode("utf-8", "ignore")
    expected = INTERNAL_SERVICE_SECRET.encode("utf-8")
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=404, detail="not found")


router = APIRouter()


# ── Resolve (used by webmap-backend providers) ────────────────────


@router.get("/datasets/{dataset_id}/resolve", response_model=DatasetResolveOut)
async def resolve_dataset(
    dataset_id: int,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    """Return the filesystem root path for a dataset. Used by the webmap backend."""
    ds = await require_dataset_access(dataset_id, db, user)

    root = dataset_root(ds.owner_id, ds.id, ds.is_public)
    return DatasetResolveOut(
        dataset_id=ds.id,
        root_path=str(root),
        has_synthetic=ds.has_synthetic,
        has_microcensus=ds.has_microcensus,
        has_json_preview=ds.has_json_preview,
        has_spider_db=ds.has_spider_db,
    )


# ── User storage lifecycle (called by auth backend) ──────────────


@router.post("/internal/init-user/{user_id}", dependencies=[Depends(require_internal_secret)])
async def init_user_storage(user_id: int):
    """Create per-user storage directory. Called by auth backend after registration."""
    user_dir = Path(DATASET_STORAGE_ROOT) / str(user_id)
    user_dir.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "path": str(user_id)}


@router.delete("/internal/delete-user/{user_id}", dependencies=[Depends(require_internal_secret)])
async def delete_user_storage(user_id: int, db: AsyncSession = Depends(get_db)):
    """Delete all datasets and storage for a user. Called by auth backend on hard delete."""
    user_datasets = (
        await db.scalars(select(Dataset).where(Dataset.owner_id == user_id))
    ).all()
    for ds in user_datasets:
        delete_dataset_dirs(ds.owner_id, ds.id, ds.is_public)
        await db.delete(ds)
    await db.commit()

    user_dir = Path(DATASET_STORAGE_ROOT) / str(user_id)
    if user_dir.exists():
        shutil.rmtree(user_dir)

    return {"ok": True, "deleted_datasets": len(user_datasets)}

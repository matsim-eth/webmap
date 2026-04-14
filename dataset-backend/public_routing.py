"""Public dataset endpoints — routed by Nginx via /backend/datasets/."""

import logging
import os
from pathlib import Path

from AuthAPI import RequireUser, RequireAdminUser
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_db, require_dataset_access
from models import Dataset, DatasetStatus
from schemas import (
    AdminDatasetCreate,
    AdminDatasetUpdate,
    DatasetCreate,
    DatasetListOut,
    DatasetOut,
    DatasetUpdate,
    FileListOut,
)
from storage import (
    check_dataset_completeness,
    create_dataset_dirs,
    dataset_root,
    delete_dataset_dirs,
    list_data_categories,
    list_files,
    slugify,
    validate_filename,
    ALLOWED_EXTENSIONS,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Helpers ──────────────────────────────────────────────────────


def _dataset_to_out(ds: Dataset) -> DatasetOut:
    return DatasetOut(
        id=ds.id,
        name=ds.name,
        slug=ds.slug,
        description=ds.description,
        owner_id=ds.owner_id,
        owner_username=ds.owner_username,
        status=ds.status.value if isinstance(ds.status, DatasetStatus) else ds.status,
        is_public=ds.is_public,
        has_synthetic=ds.has_synthetic,
        has_microcensus=ds.has_microcensus,
        has_json_preview=ds.has_json_preview,
        has_spider_db=ds.has_spider_db,
        data_categories=list_data_categories(ds.owner_id, ds.id, ds.is_public),
        created_at=ds.created_at,
        updated_at=ds.updated_at,
    )


# ── Dataset CRUD ─────────────────────────────────────────────────


@router.get("/datasets", response_model=DatasetListOut)
async def list_datasets(
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    uid = user.id

    # Private
    own = (
        await db.scalars(
            select(Dataset).where(Dataset.owner_id == uid, Dataset.is_public == False).order_by(Dataset.created_at.desc())
        )
    ).all()

    # Public
    public = (
        await db.scalars(
            select(Dataset).where(Dataset.is_public == True).order_by(Dataset.created_at.desc())
        )
    ).all()

    result = [_dataset_to_out(ds) for ds in own]
    result += [_dataset_to_out(ds) for ds in public]

    return DatasetListOut(datasets=result)


@router.get("/datasets/{dataset_id}", response_model=DatasetOut)
async def get_dataset(
    dataset_id: int,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    ds = await require_dataset_access(dataset_id, db, user)
    return _dataset_to_out(ds)


@router.post("/datasets", response_model=DatasetOut, status_code=status.HTTP_201_CREATED)
async def create_dataset(
    body: DatasetCreate,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy.exc import IntegrityError
    from models import _generate_dataset_id

    uid = user.id
    uname = user.claims.get("username") or user.claims.get("email") or "unknown"
    slug = slugify(body.name)

    # Check uniqueness
    existing = await db.scalar(
        select(Dataset).where(Dataset.owner_id == uid, Dataset.slug == slug)
    )
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="dataset with this name already exists")

    for attempt in range(10):
        ds = Dataset(
            id=_generate_dataset_id(),
            name=body.name,
            slug=slug,
            description=body.description,
            owner_id=uid,
            owner_username=uname,
            status=DatasetStatus.INACTIVE,
        )
        db.add(ds)
        try:
            await db.commit()
            break
        except IntegrityError:
            await db.rollback()
            if attempt == 9:
                raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="failed to generate unique dataset ID")
            continue

    await db.refresh(ds)
    create_dataset_dirs(uid, ds.id)

    return _dataset_to_out(ds)


@router.patch("/datasets/{dataset_id}", response_model=DatasetOut)
async def update_dataset(
    dataset_id: int,
    body: DatasetUpdate,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    ds = await require_dataset_access(dataset_id, db, user)
    if ds.owner_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="only owner can update")

    if body.name is not None:
        ds.name = body.name
    if body.description is not None:
        ds.description = body.description

    await db.commit()
    await db.refresh(ds)
    return _dataset_to_out(ds)


@router.delete("/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(
    dataset_id: int,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    ds = await require_dataset_access(dataset_id, db, user)
    if ds.owner_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="only owner can delete")

    delete_dataset_dirs(ds.owner_id, ds.id, ds.is_public)
    await db.delete(ds)
    await db.commit()


# ── File upload ──────────────────────────────────────────────────


@router.post("/datasets/{dataset_id}/upload/{category}")
async def upload_files(
    dataset_id: int,
    category: str,
    files: list[UploadFile] = File(...),
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    if category not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid category: {category}. Must be one of: {list(ALLOWED_EXTENSIONS.keys())}",
        )

    ds = await require_dataset_access(dataset_id, db, user)
    if ds.owner_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="only owner can upload")

    root = dataset_root(ds.owner_id, ds.id, ds.is_public)
    cat_dir = root / category
    cat_dir.mkdir(parents=True, exist_ok=True)

    uploaded = []
    for f in files:
        if not validate_filename(f.filename, category):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"invalid filename: {f.filename}",
            )
        target = cat_dir / Path(f.filename).name
        content = await f.read()
        target.write_bytes(content)
        uploaded.append(f.filename)

    # Update completeness flags
    completeness = check_dataset_completeness(ds.owner_id, ds.id, ds.is_public)
    ds.has_synthetic = completeness["has_synthetic"]
    ds.has_microcensus = completeness["has_microcensus"]
    ds.has_json_preview = completeness["has_json_preview"]
    ds.has_spider_db = completeness["has_spider_db"]
    await db.commit()

    return {"uploaded": uploaded, "category": category}


@router.get("/datasets/{dataset_id}/files", response_model=list[FileListOut])
async def get_files(
    dataset_id: int,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    ds = await require_dataset_access(dataset_id, db, user)
    result = []
    for cat in ("synthetic", "microcensus", "json_preview"):
        files = list_files(ds.owner_id, ds.id, cat, ds.is_public)
        result.append(FileListOut(category=cat, files=files))
    return result


# ── Validate ─────────────────────────────────────────────────────


@router.post("/datasets/{dataset_id}/validate", response_model=DatasetOut)
async def validate_dataset(
    dataset_id: int,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    ds = await require_dataset_access(dataset_id, db, user)
    if ds.owner_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="only owner can validate")

    completeness = check_dataset_completeness(ds.owner_id, ds.id, ds.is_public)
    ds.has_synthetic = completeness["has_synthetic"]
    ds.has_microcensus = completeness["has_microcensus"]
    ds.has_json_preview = completeness["has_json_preview"]
    ds.has_spider_db = completeness["has_spider_db"]

    await db.commit()
    await db.refresh(ds)
    return _dataset_to_out(ds)


# ── Admin endpoints ─────────────────────────────────────────────


@router.get("/admin/datasets", response_model=dict)
async def admin_list_all_datasets(
    owner_id: int | None = None,
    admin=Depends(RequireAdminUser()),
    db: AsyncSession = Depends(get_db),
):
    """List ALL datasets in the system, optionally filtered by owner. Admin only."""
    query = select(Dataset).order_by(Dataset.created_at.desc())
    if owner_id is not None:
        query = query.where(Dataset.owner_id == owner_id)
    all_ds = (await db.scalars(query)).all()
    return {
        "datasets": [
            {
                "id": ds.id,
                "name": ds.name,
                "slug": ds.slug,
                "description": ds.description,
                "owner_id": ds.owner_id,
                "owner_username": ds.owner_username,
                "status": ds.status.value if isinstance(ds.status, DatasetStatus) else ds.status,
                "is_public": ds.is_public,
                "has_synthetic": ds.has_synthetic,
                "has_microcensus": ds.has_microcensus,
                "has_json_preview": ds.has_json_preview,
                "has_spider_db": ds.has_spider_db,
                "data_categories": list_data_categories(ds.owner_id, ds.id, ds.is_public),
                "created_at": ds.created_at.isoformat() if ds.created_at else None,
                "updated_at": ds.updated_at.isoformat() if ds.updated_at else None,
            }
            for ds in all_ds
        ]
    }


@router.delete("/admin/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_delete_dataset(
    dataset_id: int,
    admin=Depends(RequireAdminUser()),
    db: AsyncSession = Depends(get_db),
):
    """Delete any dataset. Admin only."""
    ds = await db.get(Dataset, dataset_id)
    if not ds:
        raise HTTPException(status_code=404, detail="dataset not found")
    delete_dataset_dirs(ds.owner_id, ds.id, ds.is_public)
    await db.delete(ds)
    await db.commit()


@router.post("/admin/datasets", response_model=dict, status_code=status.HTTP_201_CREATED)
async def admin_create_dataset(
    body: AdminDatasetCreate,
    admin=Depends(RequireAdminUser()),
    db: AsyncSession = Depends(get_db),
):
    """Create a dataset for any user. Admin only."""
    from sqlalchemy.exc import IntegrityError
    from models import _generate_dataset_id

    slug = slugify(body.name)

    for attempt in range(3):
        ds = Dataset(
            id=_generate_dataset_id(),
            name=body.name,
            slug=slug,
            description=body.description,
            owner_id=body.owner_id,
            owner_username=body.owner_username or "unknown",
            status=DatasetStatus.INACTIVE,
            is_public=body.is_public,
        )
        db.add(ds)
        try:
            await db.commit()
            break
        except IntegrityError:
            await db.rollback()
            if attempt == 2:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="failed to generate unique dataset ID",
                )
            continue

    await db.refresh(ds)
    create_dataset_dirs(body.owner_id, ds.id, body.is_public)

    return {
        "id": ds.id,
        "name": ds.name,
        "slug": ds.slug,
        "description": ds.description,
        "owner_id": ds.owner_id,
        "owner_username": ds.owner_username,
        "status": ds.status.value if isinstance(ds.status, DatasetStatus) else ds.status,
        "is_public": ds.is_public,
        "created_at": ds.created_at.isoformat() if ds.created_at else None,
    }


@router.patch("/admin/datasets/{dataset_id}", response_model=dict)
async def admin_update_dataset(
    dataset_id: int,
    body: AdminDatasetUpdate,
    admin=Depends(RequireAdminUser()),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import text as sql_text

    ds = await db.get(Dataset, dataset_id)
    if not ds:
        raise HTTPException(status_code=404, detail="dataset not found")

    if body.name is not None:
        ds.name = body.name
        ds.slug = slugify(body.name)
    if body.description is not None:
        ds.description = body.description
    if body.status is not None:
        try:
            ds.status = DatasetStatus(body.status)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"invalid status: {body.status}. Must be one of: active, inactive",
            )
    if body.is_public is not None:
        ds.is_public = body.is_public
    new_id = None
    if body.id is not None and body.id != dataset_id:
        existing = await db.get(Dataset, body.id)
        if existing:
            raise HTTPException(status_code=409, detail=f"dataset with id {body.id} already exists")
        new_id = body.id

    await db.commit()

    if new_id is not None:
        await db.execute(sql_text(
            "UPDATE datasets SET id = :new_id WHERE id = :old_id"
        ), {"new_id": new_id, "old_id": dataset_id})
        await db.commit()
        # Rename storage directory
        old_root = dataset_root(ds.owner_id, dataset_id, ds.is_public)
        new_root = dataset_root(ds.owner_id, new_id, ds.is_public)
        if old_root.exists() and not new_root.exists():
            old_root.rename(new_root)
        ds = await db.get(Dataset, new_id)
    else:
        await db.refresh(ds)

    return {
        "id": ds.id,
        "name": ds.name,
        "slug": ds.slug,
        "description": ds.description,
        "owner_id": ds.owner_id,
        "owner_username": ds.owner_username,
        "status": ds.status.value if isinstance(ds.status, DatasetStatus) else ds.status,
        "is_public": ds.is_public,
        "created_at": ds.created_at.isoformat() if ds.created_at else None,
        "updated_at": ds.updated_at.isoformat() if ds.updated_at else None,
    }

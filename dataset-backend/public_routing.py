"""Public dataset endpoints — routed by Nginx via /backend/datasets/."""

import logging
import os
import shutil
from pathlib import Path

from AuthAPI import RequireUser, RequireAdminUser
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import (
    get_db,
    require_dataset_access,
    require_dataset_manage,
    require_dataset_write,
)
from models import Dataset, DatasetGrant, DatasetStatus
from schemas import (
    AdminDatasetCreate,
    AdminDatasetUpdate,
    DatasetCreate,
    DatasetListOut,
    DatasetOut,
    DatasetUpdate,
    FileListOut,
    GrantIn,
    GrantOut,
    RezoneIn,
)
from storage import (
    check_dataset_completeness,
    create_dataset_dirs,
    dataset_root,
    delete_dataset_dirs,
    duckdb_path,
    list_data_categories,
    list_files,
    slugify,
    DUCKDB_CATEGORIES,
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

    # Shared with me (grants on other users' private datasets)
    shared = (
        await db.scalars(
            select(Dataset)
            .join(DatasetGrant, DatasetGrant.dataset_id == Dataset.id)
            .where(DatasetGrant.user_id == uid,
                   Dataset.owner_id != uid,
                   Dataset.is_public == False)
            .order_by(Dataset.created_at.desc())
        )
    ).all()

    # Public
    public = (
        await db.scalars(
            select(Dataset).where(Dataset.is_public == True).order_by(Dataset.created_at.desc())
        )
    ).all()

    result = [_dataset_to_out(ds) for ds in own]
    result += [_dataset_to_out(ds) for ds in shared]
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


# ── DuckDB upload ─────────────────────────────────────────────────


async def _store_duckdb(ds: Dataset, category: str, file: UploadFile, db: AsyncSession) -> dict:
    """Stream an uploaded DuckDB file to ``<root>/{category}.duckdb`` and refresh flags."""
    if category not in DUCKDB_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid category: {category}. Must be one of: {list(DUCKDB_CATEGORIES)}",
        )
    if Path(file.filename).suffix.lower() != ".duckdb":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="only .duckdb files are accepted",
        )

    target = duckdb_path(ds.owner_id, ds.id, category, ds.is_public)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Stream to a temp file in the same directory, then atomically swap it in.
    # An in-place truncating write would expose a zero-length/partial file to
    # the webmap-backend, which keeps this duckdb open read-only on the shared
    # volume. os.replace is atomic on one filesystem, so a concurrent reader
    # only ever sees the complete old file or the complete new one.
    tmp = target.with_name(f"{target.name}.upload-{os.getpid()}.tmp")
    try:
        with tmp.open("wb") as out:
            shutil.copyfileobj(file.file, out, length=1024 * 1024)
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)

    completeness = check_dataset_completeness(ds.owner_id, ds.id, ds.is_public)
    ds.has_synthetic = completeness["has_synthetic"]
    ds.has_microcensus = completeness["has_microcensus"]
    ds.has_json_preview = completeness["has_json_preview"]
    ds.has_spider_db = completeness["has_spider_db"]
    await db.commit()

    return {"uploaded": target.name, "category": category}


@router.post("/datasets/{dataset_id}/upload/{category}")
async def upload_duckdb(
    dataset_id: int,
    category: str,
    file: UploadFile = File(...),
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    # Owner, admin, or an 'editor' grant may upload/replace files.
    ds = await require_dataset_write(dataset_id, db, user)
    return await _store_duckdb(ds, category, file, db)


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


# ── Re-zoning (study-area dropdown) ───────────────────────────────
#
# Creates a NEW dataset (safe: the source is never modified) whose primary
# zones are a smaller admin level from the source's own hot_polygons —
# e.g. "Canton Zürich, zoned by municipality". The heavy build runs in a
# background thread; job state is persisted to <new_root>/.rezone.json so
# any uvicorn worker can answer the status poll.

import asyncio as _asyncio

import rezone as _rezone


@router.get("/datasets/{dataset_id}/rezone/options")
async def rezone_options(
    dataset_id: int,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    """What re-zoning is possible for this dataset (zone levels + cantons)."""
    ds = await require_dataset_manage(dataset_id, db, user)
    root = dataset_root(ds.owner_id, ds.id, ds.is_public)
    try:
        return await _asyncio.to_thread(_rezone.study_area_options, root)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="upload a synthetic DuckDB first")
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"dataset not re-zonable: {exc}")


@router.post("/datasets/{dataset_id}/rezone", status_code=status.HTTP_202_ACCEPTED)
async def rezone_dataset(
    dataset_id: int,
    body: RezoneIn,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    """Start a re-zone job. Returns the NEW dataset's id; poll
    GET /datasets/{new_id}/rezone/status until state is done/error."""
    from sqlalchemy.exc import IntegrityError
    from models import _generate_dataset_id

    src = await require_dataset_write(dataset_id, db, user)
    src_root = dataset_root(src.owner_id, src.id, src.is_public)
    if not (src_root / "synthetic.duckdb").exists():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="upload a synthetic DuckDB first")

    labels = _rezone.ZONE_TYPE_LABELS.get(body.zone_type,
                                          (body.zone_type, body.zone_type + "s"))
    label = labels[1] if len(labels) > 1 else labels[0]  # plural for names
    # Default name: "<source> · Zürich municipalities" / "<source> · districts"
    canton_name = None
    if body.canton_id is not None:
        try:
            opts = await _asyncio.to_thread(_rezone.study_area_options, src_root)
            canton_name = next((c["name"] for c in opts["cantons"]
                                if c["id"] == body.canton_id), None)
        except Exception:
            pass
        if canton_name is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail=f"canton {body.canton_id} not in this dataset")
    name = body.name or (
        f"{src.name} · {canton_name} {label.lower()}" if canton_name
        else f"{src.name} · {label.lower()}"
    )

    for attempt in range(10):
        new_ds = Dataset(
            id=_generate_dataset_id(),
            name=name,
            slug=f"{slugify(name)}-{attempt}" if attempt else slugify(name),
            description=f"Re-zoned from '{src.name}' ({src.id}): "
                        f"{canton_name or 'whole area'}, {labels[0].lower()} zones",
            owner_id=src.owner_id,
            owner_username=src.owner_username,
            status=DatasetStatus.INACTIVE,
            is_public=src.is_public,
        )
        db.add(new_ds)
        try:
            await db.commit()
            break
        except IntegrityError:
            await db.rollback()
            if attempt == 9:
                raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                    detail="failed to create dataset record")
    await db.refresh(new_ds)
    new_root = create_dataset_dirs(new_ds.owner_id, new_ds.id, new_ds.is_public)

    _rezone.start_rezone_thread(
        src_root, new_root, body.canton_id, body.zone_type,
        # Study-area display name (map header), not the dataset record name.
        (f"{canton_name}" if canton_name else src.name),
        source_dataset_id=src.id,
    )
    return {"dataset_id": new_ds.id, "name": new_ds.name, "state": "running"}


@router.get("/datasets/{dataset_id}/rezone/status")
async def rezone_status(
    dataset_id: int,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    """Job status of a re-zoned dataset (owner or admin; works while the
    dataset is still INACTIVE)."""
    ds = await require_dataset_manage(dataset_id, db, user)
    job = _rezone.read_job(dataset_root(ds.owner_id, ds.id, ds.is_public))
    if job is None:
        raise HTTPException(status_code=404, detail="no re-zone job for this dataset")
    if job.get("state") == "done" and not ds.has_synthetic:
        completeness = check_dataset_completeness(ds.owner_id, ds.id, ds.is_public)
        ds.has_synthetic = completeness["has_synthetic"]
        ds.has_microcensus = completeness["has_microcensus"]
        ds.has_json_preview = completeness["has_json_preview"]
        ds.has_spider_db = completeness["has_spider_db"]
        await db.commit()
    job.pop("trace", None)
    return job


# ── Sharing / grants ─────────────────────────────────────────────
#
# Owner or admin manages who may access a PRIVATE dataset:
#   viewer — read (map + dashboard), editor — read + upload.
# Public datasets need no grants (readable by everyone).


@router.get("/datasets/{dataset_id}/grants", response_model=list[GrantOut])
async def list_grants(
    dataset_id: int,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    await require_dataset_manage(dataset_id, db, user)
    grants = (await db.scalars(
        select(DatasetGrant).where(DatasetGrant.dataset_id == dataset_id)
        .order_by(DatasetGrant.created_at)
    )).all()
    return [GrantOut(user_id=g.user_id, role=g.role, granted_by=g.granted_by,
                     created_at=g.created_at) for g in grants]


@router.post("/datasets/{dataset_id}/grants", response_model=GrantOut,
             status_code=status.HTTP_201_CREATED)
async def add_grant(
    dataset_id: int,
    body: GrantIn,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    ds = await require_dataset_manage(dataset_id, db, user)
    if ds.is_public:
        raise HTTPException(status_code=400, detail="public datasets are accessible to everyone already")
    if body.user_id == ds.owner_id:
        raise HTTPException(status_code=400, detail="the owner already has full access")
    if body.role not in ("viewer", "editor"):
        raise HTTPException(status_code=422, detail="role must be 'viewer' or 'editor'")

    existing = await db.scalar(select(DatasetGrant).where(
        DatasetGrant.dataset_id == dataset_id, DatasetGrant.user_id == body.user_id))
    if existing:
        existing.role = body.role      # idempotent upsert: adjust the role
        await db.commit()
        await db.refresh(existing)
        g = existing
    else:
        g = DatasetGrant(dataset_id=dataset_id, user_id=body.user_id,
                         role=body.role, granted_by=user.id)
        db.add(g)
        await db.commit()
        await db.refresh(g)
    return GrantOut(user_id=g.user_id, role=g.role, granted_by=g.granted_by,
                    created_at=g.created_at)


@router.delete("/datasets/{dataset_id}/grants/{grant_user_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def remove_grant(
    dataset_id: int,
    grant_user_id: int,
    user=Depends(RequireUser()),
    db: AsyncSession = Depends(get_db),
):
    await require_dataset_manage(dataset_id, db, user)
    g = await db.scalar(select(DatasetGrant).where(
        DatasetGrant.dataset_id == dataset_id, DatasetGrant.user_id == grant_user_id))
    if not g:
        raise HTTPException(status_code=404, detail="grant not found")
    await db.delete(g)
    await db.commit()


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


@router.post("/admin/datasets/{dataset_id}/upload/{category}")
async def admin_upload_duckdb(
    dataset_id: int,
    category: str,
    file: UploadFile = File(...),
    admin=Depends(RequireAdminUser()),
    db: AsyncSession = Depends(get_db),
):
    """Upload a source DuckDB file to any dataset. Admin only."""
    ds = await db.get(Dataset, dataset_id)
    if not ds:
        raise HTTPException(status_code=404, detail="dataset not found")
    return await _store_duckdb(ds, category, file, db)


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

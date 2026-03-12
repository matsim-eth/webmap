"""Dataset service — manages per-user datasets, uploads, and permissions."""

import logging
import os
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

import AuthAPI
from AuthAPI import API
from AuthAPI import RequireAdminUser
from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile, File, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from dependencies import (
    get_db,
    get_current_user,
    require_dataset_access,
    _user_id,
    _username,
    engine,
)
from models import Base, Dataset, DatasetPermission, DatasetStatus, PermissionLevel, PUBLIC_DEMO_ID
from schemas import (
    AdminDatasetCreate,
    AdminDatasetUpdate,
    DatasetCreate,
    DatasetListOut,
    DatasetOut,
    DatasetResolveOut,
    DatasetUpdate,
    FileListOut,
    PermissionGrant,
    PermissionOut,
)
from storage import (
    check_dataset_completeness,
    create_dataset_dirs,
    dataset_root,
    delete_dataset_dirs,
    list_files,
    slugify,
    validate_filename,
    ALLOWED_EXTENSIONS,
)

# ── Config ───────────────────────────────────────────────────────

API.init(
    secret_key=os.getenv("JWT_SECRET", "UltraSecretKey"),
    algorithm=os.getenv("JWT_ALG", "HS256"),
    access_minutes=int(os.getenv("ACCESS_TOKEN_MINUTES", "15")),
    refresh_days=int(os.getenv("REFRESH_TOKEN_DAYS", "14")),
    bcrypt_rounds=int(os.getenv("BCRYPT_ROUNDS", "12")),
    access_cookie_name=os.getenv("ACCESS_COOKIE_NAME", "access_token"),
    use_db=False,
)

APP_NAME = os.getenv("APP_NAME", "dataset-service")
ENV = os.getenv("ENV", "dev")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

ALLOWED_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
TRUSTED_HOSTS = [h.strip() for h in os.getenv("TRUSTED_HOSTS", "").split(",") if h.strip()]

logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(APP_NAME)

# ── App ──────────────────────────────────────────────────────────


DATASET_STORAGE_ROOT = os.getenv("DATASET_STORAGE_ROOT", "/data/datasets")


async def _seed_public_demo(db: AsyncSession) -> None:
    """Ensure the public demo dataset record exists in the DB.

    Handles both fresh databases (creates with PUBLIC_DEMO_ID) and existing
    databases that already have a demo dataset under a different ID.
    Also migrates data files between old and new directory names.
    """
    # 1. Check if any public demo already exists (by slug or by is_public)
    existing = await db.scalar(
        select(Dataset).where(Dataset.is_public == True, Dataset.slug == "public_demo")
    )
    if not existing:
        # Also try by exact ID (in case slug differs)
        existing = await db.get(Dataset, PUBLIC_DEMO_ID)

    if existing:
        demo_id = existing.id
        logger.info("Public demo dataset already seeded (id=%s)", demo_id)
    else:
        # Fresh DB — create with the canonical 10-digit ID
        ds = Dataset(
            id=PUBLIC_DEMO_ID,
            name="Public Demo",
            slug="public_demo",
            description="Built-in demo dataset with synthetic Swiss mobility data",
            owner_id=0,
            owner_username="system",
            status=DatasetStatus.READY,
            is_public=True,
            has_synthetic=True,
            has_microcensus=True,
            has_json_preview=True,
            has_spider_db=False,
        )
        db.add(ds)
        await db.commit()
        await db.refresh(ds)
        demo_id = ds.id
        logger.info("Created public demo dataset id=%s", demo_id)
        existing = ds

    # 2. Ensure data files are at the correct path for whichever ID we have
    public_dir = Path(DATASET_STORAGE_ROOT) / "public"
    target = public_dir / str(demo_id)

    # Check if target already has data
    target_has_data = target.exists() and any(
        (target / cat).exists() and any((target / cat).iterdir())
        for cat in ("synthetic", "microcensus", "json_preview")
        if (target / cat).exists()
    )

    if not target_has_data:
        # Look for data under other known directory names and migrate
        candidates = [str(PUBLIC_DEMO_ID), "1"]
        for cand in candidates:
            src = public_dir / cand
            if src == target:
                continue
            if src.exists() and any(src.iterdir()):
                logger.info("Migrating demo data from public/%s/ to public/%s/", cand, demo_id)
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(src, target)
                break

    # Ensure directories exist
    for category in ("synthetic", "microcensus", "json_preview"):
        (target / category).mkdir(parents=True, exist_ok=True)

    # Update completeness flags from actual files on disk
    completeness = check_dataset_completeness(0, demo_id, True)
    existing.has_synthetic = completeness["has_synthetic"]
    existing.has_microcensus = completeness["has_microcensus"]
    existing.has_json_preview = completeness["has_json_preview"]
    existing.has_spider_db = completeness["has_spider_db"]
    await db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    from sqlalchemy import text
    if os.getenv("DB_CREATE_TABLES", "0") == "1":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    # Ensure is_public column exists (for existing databases)
    async with engine.begin() as conn:
        await conn.execute(text(
            "ALTER TABLE datasets ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE"
        ))
    # Ensure public storage directory exists
    Path(DATASET_STORAGE_ROOT, "public").mkdir(parents=True, exist_ok=True)

    # Seed the public demo dataset (moves flat data into public/{id}/ structure)
    from dependencies import async_session
    async with async_session() as db:
        try:
            await _seed_public_demo(db)
        except Exception:
            logger.exception("Failed to seed public demo dataset")

    yield
    await engine.dispose()


docs_url = None if ENV == "prod" else "/docs"
redoc_url = None if ENV == "prod" else "/redoc"
openapi_url = None if ENV == "prod" else "/openapi.json"

app = FastAPI(
    title=APP_NAME,
    lifespan=lifespan,
    docs_url=docs_url,
    redoc_url=redoc_url,
    openapi_url=openapi_url,
)

if TRUSTED_HOSTS:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=TRUSTED_HOSTS)

app.add_middleware(GZipMiddleware, minimum_size=1000)

if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Location", "Set-Cookie"],
    )


# ── Exception handlers ──────────────────────────────────────────


class ErrorOut(BaseModel):
    detail: str


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("unhandled_error")
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal Server Error"},
    )


# ── Health ───────────────────────────────────────────────────────


@app.get("/health", response_model=dict)
async def health():
    return {"status": "ok", "service": APP_NAME, "env": ENV}


# ── Helpers ──────────────────────────────────────────────────────


def _dataset_to_out(ds: Dataset, perm_level: str) -> DatasetOut:
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
        created_at=ds.created_at,
        updated_at=ds.updated_at,
        permission_level=perm_level,
    )


# ── Dataset CRUD ─────────────────────────────────────────────────


@app.get("/datasets", response_model=DatasetListOut)
async def list_datasets(
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List own datasets, shared datasets, and public datasets."""
    uid = _user_id(user)

    # Own datasets
    own = (
        await db.scalars(
            select(Dataset).where(Dataset.owner_id == uid, Dataset.is_public == False).order_by(Dataset.created_at.desc())
        )
    ).all()

    # Public datasets (accessible to everyone)
    public = (
        await db.scalars(
            select(Dataset).where(Dataset.is_public == True).order_by(Dataset.created_at.desc())
        )
    ).all()

    # Shared datasets
    shared_ids = (
        await db.scalars(
            select(DatasetPermission.dataset_id).where(DatasetPermission.user_id == uid)
        )
    ).all()
    shared = []
    if shared_ids:
        shared = (
            await db.scalars(
                select(Dataset).where(Dataset.id.in_(shared_ids), Dataset.is_public == False).order_by(Dataset.created_at.desc())
            )
        ).all()

    # Build permission map for shared datasets
    perm_map: dict[int, str] = {}
    if shared_ids:
        perms = (
            await db.scalars(
                select(DatasetPermission).where(
                    DatasetPermission.user_id == uid,
                    DatasetPermission.dataset_id.in_(shared_ids),
                )
            )
        ).all()
        perm_map = {p.dataset_id: p.level.value for p in perms}

    result = [_dataset_to_out(ds, "owner") for ds in own]
    result += [_dataset_to_out(ds, "read") for ds in public]
    result += [_dataset_to_out(ds, perm_map.get(ds.id, "read")) for ds in shared]

    return DatasetListOut(datasets=result)


@app.get("/datasets/{dataset_id}", response_model=DatasetOut)
async def get_dataset(
    dataset_id: int,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ds, perm = await require_dataset_access(dataset_id, db, user)
    return _dataset_to_out(ds, perm)


@app.post("/datasets", response_model=DatasetOut, status_code=status.HTTP_201_CREATED)
async def create_dataset(
    body: DatasetCreate,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy.exc import IntegrityError
    from models import _generate_dataset_id

    uid = _user_id(user)
    uname = _username(user)
    slug = slugify(body.name)

    # Check uniqueness
    existing = await db.scalar(
        select(Dataset).where(Dataset.owner_id == uid, Dataset.slug == slug)
    )
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="dataset with this name already exists")

    # Retry up to 3 times for random ID collisions (extremely unlikely)
    for attempt in range(3):
        ds = Dataset(
            id=_generate_dataset_id(),
            name=body.name,
            slug=slug,
            description=body.description,
            owner_id=uid,
            owner_username=uname,
            status=DatasetStatus.PENDING,
        )
        db.add(ds)
        try:
            await db.commit()
            break
        except IntegrityError:
            await db.rollback()
            if attempt == 2:
                raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="failed to generate unique dataset ID")
            continue

    await db.refresh(ds)

    # Create directories using dataset ID
    create_dataset_dirs(uid, ds.id)

    return _dataset_to_out(ds, "owner")


@app.patch("/datasets/{dataset_id}", response_model=DatasetOut)
async def update_dataset(
    dataset_id: int,
    body: DatasetUpdate,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ds, perm = await require_dataset_access(dataset_id, db, user)
    if perm != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="only owner can update")

    if body.name is not None:
        ds.name = body.name
    if body.description is not None:
        ds.description = body.description

    await db.commit()
    await db.refresh(ds)
    return _dataset_to_out(ds, "owner")


@app.delete("/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(
    dataset_id: int,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ds, perm = await require_dataset_access(dataset_id, db, user)
    if perm != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="only owner can delete")

    # Delete files first
    delete_dataset_dirs(ds.owner_id, ds.id, ds.is_public)

    # Delete from DB (cascades to permissions)
    await db.delete(ds)
    await db.commit()


# ── File upload ──────────────────────────────────────────────────


@app.post("/datasets/{dataset_id}/upload/{category}")
async def upload_files(
    dataset_id: int,
    category: str,
    files: list[UploadFile] = File(...),
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if category not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid category: {category}. Must be one of: {list(ALLOWED_EXTENSIONS.keys())}",
        )

    ds, perm = await require_dataset_access(dataset_id, db, user)
    # Re-check: owner or write permission
    uid = _user_id(user)
    if ds.owner_id != uid:
        ds, perm = await require_dataset_access(dataset_id, db, user, require_write=True)

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


@app.get("/datasets/{dataset_id}/files", response_model=list[FileListOut])
async def get_files(
    dataset_id: int,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ds, _ = await require_dataset_access(dataset_id, db, user)
    result = []
    for cat in ("synthetic", "microcensus", "json_preview"):
        files = list_files(ds.owner_id, ds.id, cat, ds.is_public)
        result.append(FileListOut(category=cat, files=files))
    return result


# ── Validate ─────────────────────────────────────────────────────


@app.post("/datasets/{dataset_id}/validate", response_model=DatasetOut)
async def validate_dataset(
    dataset_id: int,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ds, perm = await require_dataset_access(dataset_id, db, user)
    if perm not in ("owner", "write"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="write access required")

    completeness = check_dataset_completeness(ds.owner_id, ds.id, ds.is_public)
    ds.has_synthetic = completeness["has_synthetic"]
    ds.has_microcensus = completeness["has_microcensus"]
    ds.has_json_preview = completeness["has_json_preview"]
    ds.has_spider_db = completeness["has_spider_db"]

    # Mark as ready if at least synthetic or microcensus data exists
    if completeness["has_synthetic"] or completeness["has_microcensus"]:
        ds.status = DatasetStatus.READY
    else:
        ds.status = DatasetStatus.PENDING

    await db.commit()
    await db.refresh(ds)
    return _dataset_to_out(ds, perm)


# ── Permissions ──────────────────────────────────────────────────


@app.get("/datasets/{dataset_id}/permissions", response_model=list[PermissionOut])
async def list_permissions(
    dataset_id: int,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ds, perm = await require_dataset_access(dataset_id, db, user)
    if perm != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="only owner can view permissions")

    perms = (
        await db.scalars(
            select(DatasetPermission).where(DatasetPermission.dataset_id == dataset_id)
        )
    ).all()

    return [
        PermissionOut(
            id=p.id,
            dataset_id=p.dataset_id,
            user_id=p.user_id,
            user_email=p.user_email,
            level=p.level.value,
            granted_at=p.granted_at,
            granted_by=p.granted_by,
        )
        for p in perms
    ]


@app.post("/datasets/{dataset_id}/permissions", response_model=PermissionOut, status_code=status.HTTP_201_CREATED)
async def grant_permission(
    dataset_id: int,
    body: PermissionGrant,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ds, perm = await require_dataset_access(dataset_id, db, user)
    if perm != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="only owner can grant permissions")

    uid = _user_id(user)

    if body.user_id == uid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="cannot grant permission to yourself")

    if body.level not in ("read", "write"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="level must be 'read' or 'write'")

    # Check if permission already exists
    existing = await db.scalar(
        select(DatasetPermission).where(
            DatasetPermission.dataset_id == dataset_id,
            DatasetPermission.user_id == body.user_id,
        )
    )
    if existing:
        # Update level
        existing.level = PermissionLevel(body.level)
        existing.user_email = body.user_email or existing.user_email
        await db.commit()
        await db.refresh(existing)
        p = existing
    else:
        p = DatasetPermission(
            dataset_id=dataset_id,
            user_id=body.user_id,
            user_email=body.user_email,
            level=PermissionLevel(body.level),
            granted_by=uid,
        )
        db.add(p)
        await db.commit()
        await db.refresh(p)

    return PermissionOut(
        id=p.id,
        dataset_id=p.dataset_id,
        user_id=p.user_id,
        user_email=p.user_email,
        level=p.level.value,
        granted_at=p.granted_at,
        granted_by=p.granted_by,
    )


@app.delete("/datasets/{dataset_id}/permissions/{permission_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_permission(
    dataset_id: int,
    permission_id: int,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ds, perm = await require_dataset_access(dataset_id, db, user)
    if perm != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="only owner can revoke permissions")

    p = await db.get(DatasetPermission, permission_id)
    if not p or p.dataset_id != dataset_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="permission not found")

    await db.delete(p)
    await db.commit()


# ── Resolve (internal API for webmap-backend) ────────────────────


@app.get("/datasets/{dataset_id}/resolve", response_model=DatasetResolveOut)
async def resolve_dataset(
    dataset_id: int,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the filesystem root path for a dataset. Used by the webmap backend."""
    ds, _ = await require_dataset_access(dataset_id, db, user)

    root = dataset_root(ds.owner_id, ds.id, ds.is_public)
    return DatasetResolveOut(
        dataset_id=ds.id,
        root_path=str(root),
        has_synthetic=ds.has_synthetic,
        has_microcensus=ds.has_microcensus,
        has_json_preview=ds.has_json_preview,
        has_spider_db=ds.has_spider_db,
    )


# ── Public demo helper ──────────────────────────────────────────


@app.get("/public-demo-id")
async def get_public_demo_id(db: AsyncSession = Depends(get_db)):
    """Return the ID of the public demo dataset (no auth required)."""
    ds = await db.scalar(
        select(Dataset).where(Dataset.is_public == True, Dataset.slug == "public_demo")
    )
    if not ds:
        raise HTTPException(status_code=404, detail="no public demo dataset")
    return {"id": ds.id}


# ── Internal endpoints (service-to-service) ────────────────────


@app.post("/internal/init-user/{user_id}")
async def init_user_storage(user_id: int):
    """Create per-user storage directory. Called by auth backend after registration."""
    user_dir = Path(DATASET_STORAGE_ROOT) / str(user_id)
    user_dir.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "path": str(user_id)}


@app.delete("/internal/delete-user/{user_id}")
async def delete_user_storage(user_id: int, db: AsyncSession = Depends(get_db)):
    """Delete all datasets and storage for a user. Called by auth backend on hard delete."""
    # Delete all datasets owned by this user from DB
    user_datasets = (
        await db.scalars(select(Dataset).where(Dataset.owner_id == user_id))
    ).all()
    for ds in user_datasets:
        delete_dataset_dirs(ds.owner_id, ds.id, ds.is_public)
        await db.delete(ds)
    await db.commit()

    # Remove the user's storage directory entirely
    user_dir = Path(DATASET_STORAGE_ROOT) / str(user_id)
    if user_dir.exists():
        shutil.rmtree(user_dir)

    return {"ok": True, "deleted_datasets": len(user_datasets)}


# ── Admin endpoints ─────────────────────────────────────────────


@app.get("/admin/datasets", response_model=dict)
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
                "created_at": ds.created_at.isoformat() if ds.created_at else None,
                "updated_at": ds.updated_at.isoformat() if ds.updated_at else None,
            }
            for ds in all_ds
        ]
    }


@app.delete("/admin/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
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


@app.post("/admin/datasets", response_model=dict, status_code=status.HTTP_201_CREATED)
async def admin_create_dataset(
    body: AdminDatasetCreate,
    admin=Depends(RequireAdminUser()),
    db: AsyncSession = Depends(get_db),
):
    """Create a dataset for any user. Admin only."""
    from sqlalchemy.exc import IntegrityError
    from models import _generate_dataset_id

    slug = slugify(body.name)

    # Retry up to 3 times for random ID collisions
    for attempt in range(3):
        ds = Dataset(
            id=_generate_dataset_id(),
            name=body.name,
            slug=slug,
            description=body.description,
            owner_id=body.owner_id,
            owner_username=body.owner_username or "unknown",
            status=DatasetStatus.PENDING,
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
    create_dataset_dirs(body.owner_id, ds.id)

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


@app.patch("/admin/datasets/{dataset_id}", response_model=dict)
async def admin_update_dataset(
    dataset_id: int,
    body: AdminDatasetUpdate,
    admin=Depends(RequireAdminUser()),
    db: AsyncSession = Depends(get_db),
):
    """Update any dataset's name, description, status, or is_public. Admin only."""
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
                detail=f"invalid status: {body.status}. Must be one of: pending, ready, error",
            )
    if body.is_public is not None:
        ds.is_public = body.is_public

    await db.commit()
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

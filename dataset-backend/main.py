"""Dataset service — manages per-user datasets, uploads, and permissions."""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from AuthAPI import API
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from dependencies import engine
from models import Base

# ── Config ───────────────────────────────────────────────────────

# API.init MUST run before importing routers — RequireUser() checks at import time
API.init(
    secret_key=os.getenv("JWT_SECRET", "UltraSecretKey"),
    algorithm=os.getenv("JWT_ALG", "HS256"),
    access_minutes=int(os.getenv("ACCESS_TOKEN_MINUTES", "15")),
    refresh_days=int(os.getenv("REFRESH_TOKEN_DAYS", "14")),
    bcrypt_rounds=int(os.getenv("BCRYPT_ROUNDS", "12")),
    access_cookie_name=os.getenv("ACCESS_COOKIE_NAME", "access_token"),
    use_db=False,
)

from public_routing import router as public_router  # noqa: E402
from internal_routing import router as internal_router  # noqa: E402

APP_NAME = os.getenv("APP_NAME", "dataset-service")
ENV = os.getenv("ENV", "dev")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

ALLOWED_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
TRUSTED_HOSTS = [h.strip() for h in os.getenv("TRUSTED_HOSTS", "").split(",") if h.strip()]

logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(APP_NAME)

# ── App ──────────────────────────────────────────────────────────

DATASET_STORAGE_ROOT = os.getenv("DATASET_STORAGE_ROOT", "/data/datasets")


# Schema tweaks `create_all` can't do: it creates missing *tables* but never
# alters an existing one, so a new column would be invisible on any deployment
# whose `datasets` table already exists. There is no Alembic in this repo, so
# apply the delta here — every statement is idempotent and safe to re-run.
_MIGRATIONS = (
    # The system-wide default dataset (see models.Dataset.is_default).
    "ALTER TABLE IF EXISTS datasets "
    "ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE",
    # At most one default: a partial unique index over the true rows only.
    # Without it, two concurrent PUT /admin/datasets/default calls could each
    # clear-then-set and leave two defaults, and the frontends would silently
    # disagree about which one wins.
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_datasets_single_default "
    "ON datasets (is_default) WHERE is_default",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("DB_CREATE_TABLES", "0") == "1":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    for stmt in _MIGRATIONS:
        # One transaction per statement: a failure inside a shared transaction
        # aborts it, so every *later* statement would fail too even though it
        # was fine on its own.
        try:
            async with engine.begin() as conn:
                await conn.execute(text(stmt))
        except Exception as exc:
            # Logged, not raised, so one bad statement doesn't block startup and
            # the rest still apply. Note this is NOT a graceful degradation for
            # the ADD COLUMN: `models.Dataset` declares `is_default`, so if that
            # statement fails every SELECT against `datasets` fails too. Treat
            # this warning as a broken deployment, not a benign skip.
            logger.warning("migration FAILED (%s...): %s", " ".join(stmt.split()[:4]), exc)
    Path(DATASET_STORAGE_ROOT, "public").mkdir(parents=True, exist_ok=True)
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
    root_path=os.getenv("ROOT_PATH", ""),
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


# ── Routers ──────────────────────────────────────────────────────

app.include_router(public_router)
app.include_router(internal_router)

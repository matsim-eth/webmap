import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from AuthAPI import RequireUser
from fastapi import Depends, FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from providers import ALL_PROVIDERS
from providers.base import mount_provider

# ---------------------------------------------------------------------------
# Environment / config
# ---------------------------------------------------------------------------

os.environ.setdefault("WEBMAP_ROOT", "./dummy_data/webmap_data/")

APP_NAME  = os.getenv("APP_NAME", "backend")
ENV       = os.getenv("ENV", "dev")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

LOCAL_RUN = os.getenv("LOCAL_RUN", "0").strip().lower() in {"1", "true"}

ALLOWED_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
TRUSTED_HOSTS   = [h.strip() for h in os.getenv("TRUSTED_HOSTS", "").split(",") if h.strip()]

COOKIE_SECURE    = os.getenv("COOKIE_SECURE", "1" if ENV == "prod" else "0") == "1"
COOKIE_SAMESITE  = os.getenv("COOKIE_SAMESITE", "lax")
ACCESS_COOKIE_NAME  = os.getenv("ACCESS_COOKIE_NAME",  "access_token")
REFRESH_COOKIE_NAME = os.getenv("REFRESH_COOKIE_NAME", "refresh_token")

docs_url    = None if ENV == "prod" else "/docs"
redoc_url   = None if ENV == "prod" else "/redoc"
openapi_url = None if ENV == "prod" else "/openapi.json"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(APP_NAME)

# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

def _local_user() -> dict:
    return {"username": "local"}


async def OptionalUser(request: Request) -> dict:
    if LOCAL_RUN:
        return _local_user()
    u = RequireUser(request)
    if hasattr(u, "__await__"):
        u = await u
    return u


def _ttl_seconds_from_exp(exp: int | None) -> int | None:
    if not exp:
        return None
    now = int(datetime.now(timezone.utc).timestamp())
    ttl = int(exp) - now
    return ttl if ttl > 0 else 0

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(
    title=APP_NAME,
    lifespan=lifespan,
    docs_url=docs_url,
    redoc_url=redoc_url,
    openapi_url=openapi_url,
)

# --- Middleware (order matters: added last = outermost) --------------------

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

# --- Data providers -------------------------------------------------------

for provider in ALL_PROVIDERS:
    mount_provider(app, provider, prefix="/data")

# --- Exception handlers ---------------------------------------------------

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

# --- Routes ---------------------------------------------------------------

@app.get("/health", response_model=dict)
async def health(user: dict = Depends(OptionalUser)):
    return {"status": "ok", "local_run": LOCAL_RUN, "name": user.get("username")}

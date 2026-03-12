import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from AuthAPI import API, decode_token
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from providers import ALL_PROVIDERS
from providers.base import mount_provider

# ---------------------------------------------------------------------------
# Environment / config
# ---------------------------------------------------------------------------

os.environ.setdefault("WEBMAP_ROOT", "/data/datasets/public")

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
# AuthAPI (JWT-only, no database)
# ---------------------------------------------------------------------------

if not LOCAL_RUN:
    API.init(
        secret_key=os.getenv("JWT_SECRET", "UltraSecretKey"),
        algorithm=os.getenv("JWT_ALG", "HS256"),
        access_minutes=int(os.getenv("ACCESS_TOKEN_MINUTES", "15")),
        refresh_days=int(os.getenv("REFRESH_TOKEN_DAYS", "14")),
        bcrypt_rounds=int(os.getenv("BCRYPT_ROUNDS", "12")),
        access_cookie_name=ACCESS_COOKIE_NAME,
        use_db=False,
    )

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
    token = request.cookies.get(ACCESS_COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        claims = decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return claims


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

# --- Auth middleware -------------------------------------------------------

_PUBLIC_PATHS = {"/health", "/docs", "/redoc", "/openapi.json", "/public-demo-id"}


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if LOCAL_RUN:
            return await call_next(request)
        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)
        token = request.cookies.get(ACCESS_COOKIE_NAME)
        if not token:
            return JSONResponse(
                status_code=401,
                content={"detail": "Not authenticated"},
            )
        try:
            decode_token(token)
        except Exception:
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or expired token"},
            )
        return await call_next(request)


# --- Middleware (order matters: added last = outermost) --------------------

app.add_middleware(AuthMiddleware)

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

DATASET_SERVICE_URL = os.getenv("DATASET_SERVICE_URL", "http://dataset_backend:5033")


@app.get("/health", response_model=dict)
async def health():
    return {"status": "ok", "local_run": LOCAL_RUN, "env": ENV}


@app.get("/public-demo-id", response_model=dict)
async def public_demo_id():
    """Return the ID of the public demo dataset (no auth required)."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{DATASET_SERVICE_URL}/public-demo-id")
        return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception as exc:
        logger.warning("public-demo-id failed: %s", exc)
        return JSONResponse({"error": "dataset service unavailable"}, status_code=502)


@app.get("/datasets", response_model=dict)
async def list_datasets(request: Request):
    """Proxy to dataset service — list available datasets for the current user."""
    token = request.cookies.get(ACCESS_COOKIE_NAME, "")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{DATASET_SERVICE_URL}/datasets",
                cookies={"access_token": token},
            )
        return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception as exc:
        logger.warning("dataset list failed: %s", exc)
        return JSONResponse({"error": "dataset service unavailable"}, status_code=502)


@app.get("/datasetinfo", response_model=dict)
async def dataset_info(dataset: int, request: Request):
    """Proxy to dataset service — get title and description for a dataset."""
    token = request.cookies.get(ACCESS_COOKIE_NAME, "")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{DATASET_SERVICE_URL}/datasets/{dataset}",
                cookies={"access_token": token},
            )
        if resp.status_code != 200:
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        data = resp.json()
        return {
            "id": data["id"],
            "name": data["name"],
            "description": data.get("description"),
            "status": data.get("status"),
            "is_public": data.get("is_public"),
        }
    except Exception as exc:
        logger.warning("dataset info failed: %s", exc)
        return JSONResponse({"error": "dataset service unavailable"}, status_code=502)

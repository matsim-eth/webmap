import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

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

def _prewarm_caches() -> None:
    """Background: precompute the two slow, parameter-less builds for every
    dataset so the first user never waits on a cold scan:
      • speed_dashboard — a 50M-row link_speeds scan (~30s, minutes cold);
      • transit stops    — a country-wide _build() over boarding_data + the
        1.7M-row network (~seconds, much worse on a cold mmap), which otherwise
        fires on the first stops_by_canton request.
    Runs one dataset at a time in a daemon thread; disable with WEBMAP_PREWARM=0.
    Errors are swallowed (incompatible datasets just skip)."""
    import glob
    import time
    from providers.paths import set_root_override
    from providers.link_speeds import SpeedDashboardProvider
    from providers.transit_stops import inter_cantonal_stops

    # Debounce for dev: uvicorn --reload restarts the process on every file
    # save, and each restart would immediately kick off full table scans of
    # every dataset — misery on a laptop. Waiting a bit first means rapid
    # edit-reload cycles kill the (daemon) thread before it does heavy work;
    # the cache still warms once the code settles. Prod (ENV != dev) starts
    # immediately. Override with WEBMAP_PREWARM_DELAY (seconds).
    delay = os.getenv("WEBMAP_PREWARM_DELAY", "").strip()
    delay_s = float(delay) if delay else (15.0 if ENV == "dev" else 0.0)
    if delay_s > 0:
        time.sleep(delay_s)

    base = os.getenv("WEBMAP_ROOT", "/data/datasets/public")
    roots = sorted({os.path.dirname(p) for p in glob.glob(os.path.join(base, "*", "synthetic.duckdb"))})
    from providers.study_area import study_area_dict, zones_fc_bytes

    for root in roots:
        set_root_override(root)
        try:
            # Zone layer + study-area meta: cheap, but on the critical path of
            # the very first map render (simplify + reproject + per-zone bbox
            # scan of every primary polygon) — warm them before the slow scans.
            try:
                study_area_dict()
                zones_fc_bytes(False)
                logger.info("prewarmed zones/study_area for %s", root)
            except Exception as exc:
                logger.warning("zones prewarm skipped for %s: %s", root, exc)
            try:
                SpeedDashboardProvider().deliver({})
                logger.info("prewarmed speed_dashboard for %s", root)
            except Exception as exc:
                logger.warning("speed prewarm skipped for %s: %s", root, exc)
            try:
                inter_cantonal_stops()  # triggers the per-dataset transit _build()
                logger.info("prewarmed transit stops for %s", root)
            except Exception as exc:
                logger.warning("transit prewarm skipped for %s: %s", root, exc)
            # NB: the per-line transit_routes index (providers/transit_routes.py)
            # is intentionally NOT prewarmed — it parses the ~76 MB routes asset
            # and would hold it in RAM for every dataset at startup. It builds
            # lazily on the first line selection instead (one ~6 s parse per
            # dataset per worker, then cached).
        finally:
            set_root_override(None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("WEBMAP_PREWARM", "1").strip().lower() in {"1", "true"}:
        import threading
        threading.Thread(target=_prewarm_caches, name="prewarm", daemon=True).start()
    yield


app = FastAPI(
    title=APP_NAME,
    lifespan=lifespan,
    docs_url=docs_url,
    redoc_url=redoc_url,
    openapi_url=openapi_url,
    root_path=os.getenv("ROOT_PATH", ""),
)

# --- Auth middleware -------------------------------------------------------

_PUBLIC_PATHS = {"/health", "/docs", "/redoc", "/openapi.json"}


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


# --- matsim/* geometry assets from the duckdb static_assets table ----------
# The frontend's loadWithFallback tries /backend/data/{id}/matsim/... before its
# GitHub-CDN fallback. We serve the per-canton merged_segments (zone-flow link
# geometry) straight from static_assets so the map uses the dataset's OWN
# network. Unknown paths return 404 → frontend falls back to GitHub.
import asyncio as _asyncio
import re as _re

from fastapi import Response as _Response

from providers.base import _resolve_dataset_root
from providers.paths import set_root_override as _set_root_override
from providers.helpers import load_static_asset_bytes, resolve_canton_to_polygon_id

_MERGED_SUFFIX = "_merged_segments.geojson"
_TRAFFIC_SUFFIX = "_link_traffic_volumes.json"
_COUNTS_RE = _re.compile(r"transit/per_canton_counts/(.+)_counts\.json$")
_STOPS_RE = _re.compile(r"transit/stops_by_canton/(.+)_stops\.geojson$")
_ROUTES_BY_LINE_RE = _re.compile(r"transit/routes/by_line/(.+)\.geojson$")


def _canton_id_from(name: str) -> int | None:
    """Resolve a zone name or id (as it appears in a matsim/* path) to its
    integer zone id, resolved through the dataset's zone registry. Zone ids are
    numeric, so the int-suffix parse of the returned polygon_id stays valid for
    any study area (canton, or a generalized primary zone type)."""
    pid = resolve_canton_to_polygon_id(name)
    try:
        return int(pid.split(":", 1)[1]) if pid else None
    except (ValueError, IndexError):
        return None


@app.get("/data/{dataset_id}/matsim/{asset_path:path}")
async def matsim_asset(dataset_id: int, asset_path: str, request: Request):
    """Serve matsim/* assets from the dataset's duckdb (merged_segments link
    geometry; per_canton_counts rebuilt from boarding_data). Unknown paths 404
    → the frontend's loadWithFallback then tries the GitHub CDN."""
    try:
        user = await OptionalUser(request)
        user_id = int(user.get("sub") or user.get("id") or 0)
        access_token = request.cookies.get(ACCESS_COOKIE_NAME, "")
        root = await _resolve_dataset_root(dataset_id, user_id, access_token)
        _set_root_override(root)
    except Exception:
        return JSONResponse({"error": "dataset resolution failed"}, status_code=400)
    try:
        if asset_path.endswith(_MERGED_SUFFIX):
            cid = _canton_id_from(asset_path[: -len(_MERGED_SUFFIX)])
            if cid is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            # Build the network from network_links so it carries modes/capacity/
            # length (the precomputed merged_segments blob is thin — link_id/
            # road_type/freespeed only — which blanks the Volumes car filter and
            # breaks capacity line-width). Fall back to the static blob for older
            # datasets that lack the network_links table.
            from providers.network_geometry import merged_segments_geojson
            payload = await _asyncio.to_thread(merged_segments_geojson, cid)
            if payload is None:
                payload = await _asyncio.to_thread(
                    load_static_asset_bytes, "synthetic", f"merged_segments:{cid}"
                )
            if payload is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            return _Response(content=payload, media_type="application/geo+json")

        # Per-link hourly car traffic volumes for the road "Volumes" module —
        # derived from the link_speeds table (the old preprocessed CDN asset is
        # gone). Returns [{link_id, hourly_avg_volumes:[24]}].
        if asset_path.endswith(_TRAFFIC_SUFFIX):
            cid = _canton_id_from(asset_path[: -len(_TRAFFIC_SUFFIX)])
            if cid is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            from providers.link_speeds import link_traffic_volumes
            # Optional ?min_capacity= restricts to major roads (matches the Volumes
            # "major roads only" map filter) so the default view transfers ~10× less.
            mc_raw = request.query_params.get("min_capacity")
            min_capacity = None
            if mc_raw:
                try:
                    min_capacity = float(mc_raw)
                except ValueError:
                    min_capacity = None
            rows = await _asyncio.to_thread(link_traffic_volumes, cid, min_capacity)
            return JSONResponse(rows)

        # A single transit line's route geometry — a slice of `transit_routes`
        # by line_id (tens of KB vs the full ~76 MB asset). The map overlay
        # fetches this when a line is selected so it renders immediately instead
        # of pulling the whole country's PT geometry into the browser.
        mr = _ROUTES_BY_LINE_RE.match(asset_path)
        if mr:
            from providers.transit_routes import routes_for_line_bytes
            payload = await _asyncio.to_thread(routes_for_line_bytes, mr.group(1))
            return _Response(content=payload, media_type="application/geo+json")

        # Transit line route geometry (one LineString per route) — served straight
        # from the `transit_routes` static_asset (GeoJSON BLOB) for the map overlay.
        if asset_path == "transit/routes/transit_routes.geojson":
            payload = await _asyncio.to_thread(
                load_static_asset_bytes, "synthetic", "transit_routes"
            )
            if payload is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            return _Response(content=payload, media_type="application/geo+json")

        m = _COUNTS_RE.match(asset_path)
        if m:
            cid = _canton_id_from(m.group(1))
            if cid is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            from providers.boarding_data import per_canton_counts
            rows = await _asyncio.to_thread(per_canton_counts, cid)
            return JSONResponse(rows)

        ms = _STOPS_RE.match(asset_path)
        if ms:
            # A canton's stops just loaded → start building the per-line route
            # index in the background so the line draws instantly when the user
            # clicks a stop+line moments later (instead of waiting on the parse).
            from providers.transit_routes import ensure_warm
            ensure_warm()
            name = ms.group(1)
            if name == "inter_cantonal":
                from providers.transit_stops import inter_cantonal_stops
                fc = await _asyncio.to_thread(inter_cantonal_stops)
                return JSONResponse(fc)
            cid = _canton_id_from(name)
            if cid is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            from providers.transit_stops import stops_by_canton
            fc = await _asyncio.to_thread(stops_by_canton, cid)
            return JSONResponse(fc)

        if asset_path == "transit/transit_modes_by_canton.json":
            from providers.transit_stops import transit_modes
            tm = await _asyncio.to_thread(transit_modes)
            return JSONResponse(tm)

        return JSONResponse({"error": "not found"}, status_code=404)
    except Exception as exc:
        # Incompatible/older dataset (missing static_assets etc.) must 404, not
        # 500 — the frontend's loadWithFallback then tries the GitHub CDN.
        logger.warning("matsim_asset %s failed: %s", asset_path, exc)
        return JSONResponse({"error": "not found"}, status_code=404)
    finally:
        _set_root_override(None)


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
async def health():
    return {"status": "ok", "local_run": LOCAL_RUN, "env": ENV}

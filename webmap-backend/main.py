import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from AuthAPI import API, decode_token
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from providers import ALL_PROVIDERS
from providers.base import mount_provider
from providers import warmup

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
    # Startup prewarm of the default dataset. Every *other* dataset is warmed on
    # demand instead, the first time a request for it reaches this worker — see
    # providers/warmup.py.
    warmup.start()
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

_PUBLIC_PATHS = {"/health", "/docs", "/redoc", "/openapi.json", "/ai_status"}


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


class TrafficMiddleware(BaseHTTPMiddleware):
    """Count in-flight data requests so the warm thread can stay out of the
    way (see `warmup.await_quiet`).

    `_PUBLIC_PATHS` is excluded deliberately: the container healthcheck polls
    `/health` every ~10 s, which — with a 3 s quiet threshold — would read as
    permanent traffic and starve the prewarm completely."""

    async def dispatch(self, request: Request, call_next):
        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)
        warmup.traffic_begin()
        try:
            return await call_next(request)
        finally:
            warmup.traffic_end()


# --- Middleware (order matters: added last = outermost) --------------------

# Inner relative to AuthMiddleware, so rejected (401) requests aren't counted
# as traffic — only real work the prewarm should yield to.
app.add_middleware(TrafficMiddleware)

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
import json as _json
import threading as _threading
import re as _re

from fastapi import Response as _Response

from providers.base import _resolve_dataset_root
from providers.paths import set_root_override as _set_root_override
from providers.helpers import load_static_asset_bytes, resolve_canton_to_polygon_id

_MERGED_SUFFIX = "_merged_segments.geojson"
_TRAFFIC_SUFFIX = "_link_traffic_volumes.json"
_COUNTS_RE = _re.compile(r"transit/per_canton_counts/(.+)_counts\.json$")
_PT_VOL_RE = _re.compile(r"transit/volumes_by_link_line/pt_link_volumes_by_link_line_(.+)\.json$")
_STOPS_RE = _re.compile(r"transit/stops_by_canton/(.+)_stops\.geojson$")
_ROUTES_BY_LINE_RE = _re.compile(r"transit/routes/by_line/(.+)\.geojson$")
_PT_VOLUMES_RE = _re.compile(
    r"transit/volumes_by_link_line/pt_link_volumes_by_link_line_(.+)\.json$"
)


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
        warmup.request_warm(root, warmup.profile_from_referer(request.headers.get("referer")))
    except Exception:
        return JSONResponse({"error": "dataset resolution failed"}, status_code=400)
    try:
        if asset_path.endswith(_MERGED_SUFFIX):
            cid = _canton_id_from(asset_path[: -len(_MERGED_SUFFIX)])
            if cid is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            # merged_segments_geojson serves the dataset's precomputed
            # merged_segments asset out of a per-(dataset, zone) LRU, so repeat
            # visits are cache hits.
            # ?major=1 returns only the links the frontend's MAJOR_ROADS_FILTER
            # displays — the road Volumes module's default view — which is ~5×
            # fewer features to transfer, parse and tile. Same flag and same
            # predicate as the traffic-volumes asset below.
            major = request.query_params.get("major") in ("1", "true", "True")
            # First sighting of this zone → start building its per-zone volume
            # payloads behind the traffic gate. Hooked here rather than on the
            # volume assets themselves: this request is what a network module
            # issues on entering a zone, and the user is typically seconds away
            # from switching to Volumes or Transit Volumes, which otherwise pay
            # a 3-10 s build inline.
            warmup.request_zone_warm(root, cid)
            from providers.network_geometry import merged_segments_geojson
            payload = await _asyncio.to_thread(merged_segments_geojson, cid, major)
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
            # Optional ?major=1 restricts to major roads by hierarchy (matches the
            # Volumes "major roads only" MAJOR_ROADS_FILTER) so the default view
            # transfers ~10× less. ?min_capacity= is the older pure-capacity
            # variant, kept for backward compatibility.
            major = request.query_params.get("major") in ("1", "true")
            mc_raw = request.query_params.get("min_capacity")
            min_capacity = None
            if mc_raw:
                try:
                    min_capacity = float(mc_raw)
                except ValueError:
                    min_capacity = None
            rows = await _asyncio.to_thread(link_traffic_volumes, cid, min_capacity, major)
            return JSONResponse(rows)

        # Per-canton PT link volumes (per link/line 15-min bins with a .H/.R
        # direction split) from the pt_link_volumes table. Datasets without the
        # table 404 → frontend falls back to the CDN's preprocessed file.
        mv = _PT_VOLUMES_RE.match(asset_path)
        if mv:
            cid = _canton_id_from(mv.group(1))
            if cid is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            from providers.pt_link_volumes import volumes_by_link_line
            rows = await _asyncio.to_thread(volumes_by_link_line, cid)
            if rows is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            return JSONResponse(rows)

        # Per-line .H/.R direction metadata (most common terminus stop name per
        # direction) — labels the direction filter in the transit modules.
        if asset_path == "transit/route_directions.json":
            from providers.transit_routes import route_directions
            rd = await _asyncio.to_thread(route_directions)
            if rd is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            return JSONResponse(rd)

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

        # PT passenger volumes per link/line for the Transit Volumes module —
        # from the pt_link_volumes table (scripts/build_transit_volumes).
        # Datasets without the table raise → 404 → GitHub-CDN fallback.
        mv = _PT_VOL_RE.match(asset_path)
        if mv:
            cid = _canton_id_from(mv.group(1))
            if cid is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            from providers.transit_volumes import pt_link_volumes_by_canton
            rows = await _asyncio.to_thread(pt_link_volumes_by_canton, cid)
            return JSONResponse(rows)

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
            from providers.transit_routes import ensure_warm
            name = ms.group(1)
            if name == "inter_cantonal":
                from providers.transit_stops import inter_cantonal_stops
                fc = await _asyncio.to_thread(inter_cantonal_stops)
                ensure_warm()
                return JSONResponse(fc)
            cid = _canton_id_from(name)
            if cid is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            # The transit modules' equivalent of the merged_segments hook above:
            # this is the request a zone open issues here, and Transit Volumes is
            # one click away.
            warmup.request_zone_warm(root, cid)
            from providers.transit_stops import stops_by_canton
            fc = await _asyncio.to_thread(stops_by_canton, cid)
            # Only *after* the stops are in hand: start building the per-line
            # route index in the background, so the line draws instantly when
            # the user clicks a stop+line moments later.
            #
            # Deliberately not before. `ensure_warm` parses a ~34 MB JSON asset
            # on a background thread, and that parse holds the GIL against the
            # stops build it was racing — measured on the Zurich gemeinde
            # dataset, kicking it off first turned a 1.72 s first load into
            # 6.42 s. The route index is wanted seconds later (on the first line
            # click), the stops are wanted now, so the cheap fix is to order
            # them that way rather than let them contend.
            ensure_warm()
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


# --- AI query (natural-language questions via LLM) -------------------------

# Feature flag: disabled unless explicitly turned on AND a key is configured.
# AI_QUERY_ENABLED=1 in the env (editable from the admin Environment tab).
_AI_QUERY_ENABLED = os.getenv("AI_QUERY_ENABLED", "0").strip().lower() in {"1", "true"}


def _ai_available() -> bool:
    from providers import _llm
    return _AI_QUERY_ENABLED and _llm.is_configured()


@app.get("/ai_status")
async def ai_status():
    """Cheap, unauthenticated flag the frontend polls to decide whether to
    render the Ask-AI button at all."""
    return {"enabled": _ai_available()}


# Cooperative cancellation for streaming AI runs: the frontend's Stop
# button POSTs /ai_cancel with the conversation id. This is the
# deterministic path — a client disconnect alone can be swallowed by
# proxies and by BaseHTTPMiddleware before it reaches the generator.
_ai_cancel_registry: dict[str, _threading.Event] = {}
_ai_cancel_lock = _threading.Lock()


@app.post("/ai_cancel")
async def ai_cancel(request: Request):
    """Stop a running streaming AI query (Stop button)."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    convo = str(body.get("conversation_id") or "")[:64]
    with _ai_cancel_lock:
        evt = _ai_cancel_registry.get(convo)
    if evt is not None:
        evt.set()
    return JSONResponse({"cancelled": evt is not None})


@app.post("/data/{dataset_id}/ai_query")
async def ai_query(dataset_id: int, request: Request):
    """Ask-AI endpoint: question in, {reply, display, displays, steps} out.
    Runs the multi-step agent (providers/agent.py) — the LLM chains tool
    calls over the shared tool layer. Auth + per-dataset permissions ride
    on the same resolve flow as every other data route; the LLM only ever
    sees the question and compact result summaries, never raw data files."""
    if not _ai_available():
        return JSONResponse({"reply": "The AI feature is disabled.",
                             "display": {"type": "chat"}, "error": True}, status_code=403)
    try:
        user = await OptionalUser(request)
        user_id = int(user.get("sub") or user.get("id") or 0)
        access_token = request.cookies.get(ACCESS_COOKIE_NAME, "")
        root = await _resolve_dataset_root(dataset_id, user_id, access_token)
        _set_root_override(root)
    except Exception:
        return JSONResponse({"error": "dataset resolution failed"}, status_code=400)
    try:
        body = await request.json()
        question = str(body.get("question") or "")
        history = body.get("history") or []
        # Runs are expensive: proposing one is only unlocked when the user
        # deliberately starts the message with /sim. Everything else about
        # simulations (status, confirm of an existing proposal, cancel)
        # stays available without it.
        sim_propose = bool(_re.match(r"\s*/sim\b", question, _re.IGNORECASE))
        if sim_propose:
            question = _re.sub(r"\s*/sim\b[:,]?\s*", "", question, count=1,
                               flags=_re.IGNORECASE)
        from providers.agent import run_agent
        from providers.base import DATASET_SERVICE_URL, _resolve_cache

        # Sync callbacks for the agent's worker thread: let it query OTHER
        # datasets (cross-run comparisons) with the same grant check as
        # every data route — the dataset service decides, we just ask.
        def _resolve_sync(ds_id: int) -> str:
            import httpx
            ck = (ds_id, user_id)
            if ck in _resolve_cache:
                return _resolve_cache[ck]
            r = httpx.get(f"{DATASET_SERVICE_URL}/datasets/{ds_id}/resolve",
                          cookies={"access_token": access_token}, timeout=5.0)
            if r.status_code != 200:
                raise ValueError(f"dataset {ds_id} not accessible")
            root = r.json()["root_path"]
            _resolve_cache[ck] = root
            return root

        def _list_sync() -> dict:
            import httpx
            r = httpx.get(f"{DATASET_SERVICE_URL}/datasets",
                          cookies={"access_token": access_token}, timeout=10.0)
            if r.status_code != 200:
                raise ValueError(f"dataset list failed ({r.status_code})")
            return {"datasets": [{
                "id": d.get("id"), "name": d.get("name"),
                "public": d.get("is_public"),
            } for d in r.json().get("datasets", [])]}

        # Drawn polygon from the map (ring of [lng, lat]) → WKT contextvar.
        # The geometry rides out-of-band; the LLM only learns THAT one exists.
        from providers.nl_query import set_user_polygon
        has_polygon = False
        ring = body.get("polygon")
        if (isinstance(ring, list) and 3 <= len(ring) <= 1000
                and all(isinstance(p, list) and len(p) == 2 for p in ring)):
            pts = [(float(p[0]), float(p[1])) for p in ring]
            if pts[0] != pts[-1]:
                pts.append(pts[0])
            wkt = "POLYGON((" + ", ".join(f"{x:.6f} {y:.6f}" for x, y in pts) + "))"
            set_user_polygon(wkt)
            has_polygon = True

        ui_state = (body.get("ui_state")
                    if isinstance(body.get("ui_state"), dict) else None)
        agent_kwargs = dict(
            current_dataset=dataset_id,
            resolve_dataset=_resolve_sync,
            list_datasets=_list_sync,
            conversation_id=str(body.get("conversation_id") or "")[:64] or None,
            has_polygon=has_polygon,
            ui_state=ui_state,
            # Enables the custom-simulation tools (propose/confirm/status);
            # the sim broker enforces access, quota and confirmation flow.
            sim_token=access_token or None,
            sim_propose=sim_propose,
        )

        if not body.get("stream"):
            result = await _asyncio.to_thread(run_agent, question, history,
                                              **agent_kwargs)
            return JSONResponse(result)

        # Streaming mode: NDJSON progress events (turn/delta/step/display)
        # while the agent thread works, closed by one "done" event carrying
        # the same payload the JSON path returns. Cancellation: /ai_cancel
        # sets the flag (deterministic), and a detected client disconnect
        # sets it too; the agent polls it between LLM turns, tool calls
        # and stream chunks.
        loop = _asyncio.get_running_loop()
        queue: _asyncio.Queue = _asyncio.Queue()
        cancel_evt = _threading.Event()
        convo_id = agent_kwargs["conversation_id"]
        if convo_id:
            with _ai_cancel_lock:
                _ai_cancel_registry[convo_id] = cancel_evt

        def _emit(ev: dict) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, ev)

        async def _run() -> None:
            try:
                result = await _asyncio.to_thread(
                    run_agent, question, history, emit=_emit,
                    is_cancelled=cancel_evt.is_set, **agent_kwargs)
                queue.put_nowait({"type": "done", **result})
            except Exception:
                logger.exception("ai_query stream failed")
                queue.put_nowait({
                    "type": "done", "error": True,
                    "reply": "An error occurred while running the AI query.",
                    "display": {"type": "chat"}})

        # Created inside the request context -> the task (and the worker
        # thread it spawns) inherits the root override + polygon
        # contextvars. Keep a strong reference so it isn't GC'd mid-run.
        stream_task = _asyncio.create_task(_run())

        async def _events():
            try:
                while True:
                    try:
                        ev = await _asyncio.wait_for(queue.get(), timeout=1.0)
                    except _asyncio.TimeoutError:
                        # Fallback: notice silently vanished clients too
                        if await request.is_disconnected():
                            break
                        continue
                    yield _json.dumps(ev, ensure_ascii=False, default=str) + "\n"
                    if ev.get("type") == "done":
                        break
            finally:
                cancel_evt.set()          # client gone or stream finished
                if convo_id:
                    with _ai_cancel_lock:
                        if _ai_cancel_registry.get(convo_id) is cancel_evt:
                            del _ai_cancel_registry[convo_id]
                _ = stream_task           # closure ref keeps the task alive

        return StreamingResponse(
            _events(), media_type="application/x-ndjson",
            headers={"Cache-Control": "no-cache",
                     "X-Accel-Buffering": "no",       # nginx: don't buffer
                     # GZipMiddleware buffers streams; an explicit
                     # content-encoding makes it pass chunks through as-is.
                     "Content-Encoding": "identity"})
    except Exception as exc:
        logger.exception("ai_query failed")
        return JSONResponse({"reply": "An error occurred while running the AI query.",
                             "display": {"type": "chat"}, "error": True})
    finally:
        _set_root_override(None)
        from providers.nl_query import set_user_polygon as _clear_poly
        _clear_poly(None)


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

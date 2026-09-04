#!/usr/bin/env python3
"""MCP server for the webmap transport-simulation datasets.

Exposes the shared AI tool layer (providers/ai_tools.py) to MCP clients.
Two modes:

LOCAL (stdio, default) — developer use on the machine that has the data.
    Datasets are folder names under WEBMAP_DATASETS_DIR; no auth (the
    server runs with the caller's own file permissions).

        python server.py

REMOTE (streamable HTTP) — the docker service users connect to.
    Every tool call requires  Authorization: Bearer <token>  where <token>
    is a personal API token (created in the webmap UI, "wm_...") or a
    platform access JWT. Datasets are the platform's numeric dataset IDs;
    access rights (own / public / shared) are enforced by the dataset
    service exactly like everywhere else in the stack.

        python server.py --http --host 0.0.0.0 --port 8090

Environment (remote mode):
    AUTH_SERVICE_URL     default http://authentification_backend:5032
    DATASET_SERVICE_URL  default http://dataset_backend:5033
Environment (local mode):
    WEBMAP_DATASETS_DIR  default <repo>/data/dataset-storage
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

# Import the MCP SDK *before* the backend dir joins sys.path: this folder is
# itself named "mcp", so the backend dir must be appended (never inserted at
# the front) or it would shadow the installed SDK package.
import httpx
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.append(str(BACKEND_DIR))

# ── Config ────────────────────────────────────────────────────────────────

MODE = "local"  # set to "remote" by --http in main()

DATASETS_DIR = os.getenv(
    "WEBMAP_DATASETS_DIR",
    str(BACKEND_DIR.parent / "data" / "dataset-storage"),
)
AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "http://authentification_backend:5032")
DATASET_SERVICE_URL = os.getenv("DATASET_SERVICE_URL", "http://dataset_backend:5033")

TOKEN_CACHE_TTL = 300     # verified api-token → user/JWT
RESOLVE_CACHE_TTL = 600   # (dataset_id, user_id) → root path

INSTRUCTIONS = """\
Query Swiss MATSim transport-simulation datasets (synthetic population +
microcensus) stored as read-only DuckDB files.

Typical workflow:
 1. list_datasets() to see what you may access.
 2. query_guide(dataset) once — it documents the JSON query DSL and the
    dataset's vocabulary (modes, purposes, cantons, ...).
 3. trip_query / transit_query / locate_place with a JSON plan built from
    the guide. Prefer output type "number", "table" or "chart" — "map"
    output is meant for the webmap UI and is summarized here.
 4. Standard statistics (mode share, demographics, PT subscriptions, ...)
    and synthetic-vs-microcensus comparisons: list_data_endpoints() +
    fetch_data() serve precomputed aggregates.
 5. For anything else: sql_schema() + run_sql() (read-only SELECTs).
"""

# The SDK's DNS-rebinding guard rejects any Host header it doesn't expect —
# behind nginx/vite that is the site's own hostname, so it would 421 every
# real client. Bearer-token auth is the access control here, not the Host.
mcp = FastMCP("webmap", instructions=INSTRUCTIONS,
              transport_security=TransportSecuritySettings(
                  enable_dns_rebinding_protection=False))


# ── Auth (remote mode) ────────────────────────────────────────────────────

_token_cache: dict[str, tuple[float, dict]] = {}
_resolve_cache: dict[tuple[int, int], tuple[float, str]] = {}
_cache_lock = threading.Lock()


class AuthError(Exception):
    pass


def _bearer_token(ctx: Context | None) -> str:
    request = getattr(getattr(ctx, "request_context", None), "request", None)
    auth = (request.headers.get("authorization", "") if request is not None else "")
    if not auth.lower().startswith("bearer "):
        raise AuthError(
            "Missing bearer token. Connect with an Authorization header: "
            "'Authorization: Bearer <your API token>'. Create a token in the "
            "webmap under your account menu → API tokens.")
    return auth[7:].strip()


def _verify_token(token: str) -> dict:
    """API token → {user_id, admin, access_token} (cached).

    'wm_...' tokens are exchanged at the auth service for a short-lived
    access JWT; a raw platform JWT is verified locally and used as-is."""
    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.monotonic()
    with _cache_lock:
        hit = _token_cache.get(key)
        if hit and hit[0] > now:
            return hit[1]

    if token.startswith("wm_"):
        try:
            resp = httpx.post(f"{AUTH_SERVICE_URL}/api-tokens/verify",
                              json={"token": token}, timeout=5.0)
        except httpx.HTTPError as exc:
            raise AuthError(f"auth service unreachable: {exc}") from exc
        if resp.status_code != 200:
            detail = resp.json().get("detail", "") if "json" in resp.headers.get(
                "content-type", "") else resp.text
            raise AuthError(f"token rejected: {detail or resp.status_code}")
        data = resp.json()
        info = {"user_id": int(data["user_id"]), "admin": bool(data.get("admin")),
                "access_token": data["access_token"]}
    else:
        import jwt as pyjwt
        try:
            claims = pyjwt.decode(token, os.getenv("JWT_SECRET", "UltraSecretKey"),
                                  algorithms=[os.getenv("JWT_ALG", "HS256")])
        except Exception as exc:
            raise AuthError(f"invalid token: {exc}") from exc
        if claims.get("typ") != "access":
            raise AuthError("not an access token")
        info = {"user_id": int(claims.get("sub") or claims.get("id") or 0),
                "admin": bool(claims.get("admin")), "access_token": token}

    with _cache_lock:
        _token_cache[key] = (now + TOKEN_CACHE_TTL, info)
        if len(_token_cache) > 2000:            # bound the cache
            _token_cache.clear()
    return info


def _resolve_remote_root(dataset: str, info: dict) -> str:
    try:
        dataset_id = int(dataset)
    except (TypeError, ValueError):
        raise ValueError("in remote mode 'dataset' is the numeric dataset ID "
                         "from list_datasets()")
    ck = (dataset_id, info["user_id"])
    now = time.monotonic()
    with _cache_lock:
        hit = _resolve_cache.get(ck)
        if hit and hit[0] > now:
            return hit[1]
    resp = httpx.get(f"{DATASET_SERVICE_URL}/datasets/{dataset_id}/resolve",
                     cookies={"access_token": info["access_token"]}, timeout=5.0)
    if resp.status_code != 200:
        detail = resp.json().get("detail", "") if "json" in resp.headers.get(
            "content-type", "") else resp.text
        raise ValueError(f"dataset {dataset_id} not accessible: "
                         f"{detail or resp.status_code}")
    root = resp.json()["root_path"]
    with _cache_lock:
        _resolve_cache[ck] = (now + RESOLVE_CACHE_TTL, root)
        if len(_resolve_cache) > 2000:
            _resolve_cache.clear()
    return root


# ── Local mode dataset resolution ─────────────────────────────────────────

def _is_dataset_dir(p: Path) -> bool:
    return (p / "synthetic.duckdb").is_file() or (p / "microcensus.duckdb").is_file()


def _scan_local_datasets() -> list[dict]:
    base = Path(DATASETS_DIR)
    if not base.is_dir():
        return []
    found = []
    for p in sorted(base.glob("*")) + sorted(base.glob("*/*")):
        if p.is_dir() and _is_dataset_dir(p):
            files = {}
            for name in ("synthetic.duckdb", "microcensus.duckdb"):
                f = p / name
                if f.is_file():
                    files[name.split(".")[0]] = round(f.stat().st_size / 1048576, 1)
            found.append({"dataset": str(p.relative_to(base)), "size_mb": files})
    return found


def _resolve_local_root(dataset: str) -> str:
    p = Path(dataset)
    if not p.is_absolute():
        p = Path(DATASETS_DIR) / dataset
    if not _is_dataset_dir(p):
        known = ", ".join(d["dataset"] for d in _scan_local_datasets()) or "none found"
        raise ValueError(f"'{dataset}' is not a dataset directory "
                         f"(no *.duckdb inside). Known datasets: {known}")
    return str(p)


# ── Dataset scoping ───────────────────────────────────────────────────────

@contextmanager
def _use(dataset: str, ctx: Context | None):
    """Authorize (remote mode) and scope the providers' dataset root to
    this tool call."""
    from providers.paths import set_root_override
    if MODE == "remote":
        info = _verify_token(_bearer_token(ctx))
        root = _resolve_remote_root(dataset, info)
    else:
        root = _resolve_local_root(dataset)
    set_root_override(root)
    try:
        yield
    finally:
        set_root_override(None)


def _slim(result: dict) -> dict:
    """Map GeoJSON payloads are for the webmap UI — far too large for a chat
    context. Replace them with a summary; keep everything else verbatim."""
    display = result.get("display") or {}
    gj = display.get("geojson")
    if gj and isinstance(gj, dict):
        display = {**display, "geojson": {
            "note": "geojson omitted (map output is meant for the webmap UI; "
                    "re-run with output.type='table' or 'chart' instead)",
            "n_features": len(gj.get("features", [])),
        }}
        result = {**result, "display": display}
    if isinstance(display.get("layers"), list):
        display = {**display, "layers": [
            {**l, "geojson": {"note": "geojson omitted (drawn in the webmap UI)",
                              "n_features": len((l.get("geojson") or {}).get("features", []))}}
            for l in display["layers"]]}
        result = {**result, "display": display}
    return result


# ── Tools ────────────────────────────────────────────────────────────────

@mcp.tool()
def list_datasets(ctx: Context = None) -> dict:
    """List the datasets you may access (own, public and shared with you)."""
    if MODE == "remote":
        info = _verify_token(_bearer_token(ctx))
        resp = httpx.get(f"{DATASET_SERVICE_URL}/datasets",
                         cookies={"access_token": info["access_token"]},
                         timeout=10.0)
        if resp.status_code != 200:
            raise ValueError(f"dataset service error {resp.status_code}: {resp.text[:200]}")
        out = resp.json().get("datasets", [])
        return {"datasets": [{
            "id": d.get("id"), "name": d.get("name"),
            "public": d.get("is_public"), "owner_id": d.get("owner_id"),
        } for d in out],
            "note": "pass the numeric 'id' as the dataset argument of the other tools"}
    return {"datasets_dir": DATASETS_DIR, "datasets": _scan_local_datasets()}


@mcp.tool()
def dataset_info(dataset: str, ctx: Context = None) -> dict:
    """Basic facts about one dataset: row counts, sample rate and the
    vocabulary (modes, trip purposes, income classes, transit modes)."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return {"dataset": dataset, **ai_tools.dataset_info()}


@mcp.tool()
def query_guide(dataset: str, ctx: Context = None) -> str:
    """The query-DSL documentation for this dataset: JSON schemas for trip
    plans and transit queries plus the dataset vocabulary. Read this before
    calling trip_query or transit_query. Ignore the instructions about a
    top-level reply wrapper (clear_map/refuse_reason) — here you pass the
    inner 'plan' / 'transit' objects directly to the matching tool."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return ai_tools.query_guide()


@mcp.tool()
def trip_query(dataset: str, plan: dict, title: str = "", ctx: Context = None) -> dict:
    """Run a validated trip-level query (trips x persons x households x
    routes). 'plan' is a QueryPlan JSON object as documented by query_guide:
    {"person": {...}, "household": {...}, "trip": {...}, "route": {...},
    "output": {"type": "number|table|chart", "metric": ..., ...}}."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return _slim(ai_tools.trip_query(plan, title))


@mcp.tool()
def transit_query(dataset: str, query: dict, title: str = "", ctx: Context = None) -> dict:
    """Questions about transit lines and stops (boarding data). 'query' is a
    TransitQuery JSON object as documented by query_guide, e.g.
    {"kind": "top_lines", "mode": "bus", "canton": "Zürich", "top_n": 10}."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return _slim(ai_tools.transit_query(query, title))


@mcp.tool()
def locate_place(dataset: str, name: str, ctx: Context = None) -> dict:
    """Find a place (transit stop, municipality or canton) by name and
    return its coordinates / polygon reference."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return _slim(ai_tools.locate_place(name))


@mcp.tool()
def highlight_regions(dataset: str, names: list, color: str = None,
                      ctx: Context = None) -> dict:
    """Highlight cantons / districts / municipalities as polygons (the
    geometry is drawn in the webmap UI; here it is summarized)."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return _slim(ai_tools.highlight_regions(names, color))


@mcp.tool()
def show_links(dataset: str, link_ids: list, color: str = None,
               label: str = None, ctx: Context = None) -> dict:
    """Draw specific road segments (network links) by link_id (rendered in
    the webmap UI; summarized here)."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return _slim(ai_tools.show_links(link_ids, color, label))


@mcp.tool()
def list_data_endpoints(dataset: str, ctx: Context = None) -> dict:
    """Catalog of precomputed dashboard statistics endpoints (mode share,
    age/gender distributions, PT subscriptions, car availability, distance
    histograms, ...). Most cover BOTH the synthetic simulation and the
    microcensus survey - prefer these over trip_query for standard
    statistics and synthetic-vs-microcensus comparisons."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return ai_tools.list_data_endpoints()


@mcp.tool()
def fetch_data(dataset: str, endpoint: str, params: dict = None,
               ctx: Context = None) -> dict:
    """Fetch one precomputed dashboard endpoint (see list_data_endpoints)
    with query parameters, e.g. endpoint='mode_share.json',
    params={'canton': 'Zürich', 'source': 'microcensus'}."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return ai_tools.fetch_data(endpoint, params)


@mcp.tool()
def sql_schema(dataset: str, source: str = "synthetic", table: str = None,
               ctx: Context = None) -> dict:
    """Tables and columns of a dataset's DuckDB file.
    source: 'synthetic' (simulation) or 'microcensus' (survey);
    table: optional single-table detail."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return {"dataset": dataset, **ai_tools.sql_schema(source, table)}


@mcp.tool()
def run_sql(dataset: str, sql: str, source: str = "synthetic",
            limit: int = 200, ctx: Context = None) -> dict:
    """Run a read-only SQL query (SELECT/WITH/DESCRIBE/SHOW/SUMMARIZE) against
    a dataset's DuckDB file. Use sql_schema first. Results are row-capped and
    time-limited; the database is opened read-only."""
    with _use(dataset, ctx):
        from providers import ai_tools
        return ai_tools.run_sql(sql, source, limit)


# ── Custom simulations (remote mode only — needs the user's identity) ────

def _sim_token(ctx: Context) -> str:
    if MODE != "remote":
        raise ValueError("custom simulations need the remote (HTTP) server")
    return _verify_token(_bearer_token(ctx))["access_token"]


@mcp.tool()
def propose_simulation(dataset: str, title: str, description: str,
                       operations: list, iterations: int = 40,
                       ctx: Context = None) -> dict:
    """Propose a custom MATSim run on a base dataset: a list of scenario
    operations (close_links/remove_links/modify_links/add_link/add_node/
    remove_transit_lines/scale_transit_frequency/
    scale_transit_vehicle_capacity — see the webmap docs for shapes).
    *description*: 1-2 plain-language sentences (what changes, what
    question the run answers) — shown in the user's run list and stored on
    the result dataset. Nothing runs until confirm_simulation is called
    after the human user explicitly approved the returned summary + cost
    estimate. Ask for missing details (e.g. one-way vs bidirectional for a
    new link) instead of guessing."""
    from providers import sim_client
    return sim_client.propose(_sim_token(ctx), {
        "base_dataset_id": int(dataset), "title": title,
        "description": description[:2000],
        "operations": operations, "params": {"iterations": iterations}})


@mcp.tool()
def confirm_simulation(dataset: str, job_id: int, ctx: Context = None) -> dict:
    """Start a proposed run. Call ONLY after the human explicitly approved
    the proposal — never on your own initiative."""
    from providers import sim_client
    return sim_client.confirm(_sim_token(ctx), job_id)


@mcp.tool()
def simulation_status(dataset: str, job_id: int = None,
                      ctx: Context = None) -> dict:
    """Status of the user's simulation jobs (all, or one by job_id)."""
    from providers import sim_client
    token = _sim_token(ctx)
    if job_id is not None:
        return sim_client.job_status(token, job_id)
    return sim_client.list_jobs(token)


# ── Entrypoint ────────────────────────────────────────────────────────────

def main() -> None:
    global MODE
    parser = argparse.ArgumentParser(description="webmap MCP server")
    parser.add_argument("--http", action="store_true",
                        help="streamable HTTP with bearer-token auth "
                             "(datasets = platform IDs)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args()

    if args.http:
        MODE = "remote"
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        mcp.run(transport="streamable-http")
    else:
        mcp.run()  # stdio, local filesystem mode
    return


if __name__ == "__main__":
    main()

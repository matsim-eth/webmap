"""Ops service — admin-only operational control plane.

Gives the admin panel:
  • an overview of every compose service (state, uptime, CPU, memory),
  • one-click restarts and log tails,
  • a guarded editor for the stack's root `.env` (resource limits, feature
    flags, SMTP, …) with restart hints per key.

Security model: every endpoint requires a valid `access_token` JWT cookie
whose `admin` claim is true (same JWT_SECRET as the auth service — verified
locally, no DB). The container needs the Docker socket and the project `.env`
mounted; both stay inside the internal network, routed at /backend/ops/.
"""

from __future__ import annotations

import logging
import os
import re

import docker
import jwt
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel

APP_NAME = os.getenv("APP_NAME", "ops-backend")
ENV = os.getenv("ENV", "dev")
JWT_SECRET = os.getenv("JWT_SECRET", "UltraSecretKey")
JWT_ALG = os.getenv("JWT_ALG", "HS256")
ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")
COMPOSE_PROJECT = os.getenv("COMPOSE_PROJECT", "webmap")
ENV_FILE = os.getenv("ENV_FILE", "/project/.env")

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(APP_NAME)

app = FastAPI(title=APP_NAME, root_path=os.getenv("ROOT_PATH", ""),
              docs_url=None if ENV == "prod" else "/docs",
              redoc_url=None, openapi_url=None if ENV == "prod" else "/openapi.json")


# ── Auth: admin JWT cookie, verified locally ─────────────────────


async def RequireAdmin(request: Request) -> dict:
    token = request.cookies.get(ACCESS_COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="not authenticated")
    try:
        claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except Exception:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    if claims.get("typ") != "access" or not claims.get("admin"):
        raise HTTPException(status_code=403, detail="admin only")
    return claims


# ── Docker helpers ────────────────────────────────────────────────

_client: docker.DockerClient | None = None


def _docker() -> docker.DockerClient:
    global _client
    if _client is None:
        _client = docker.from_env()
    return _client


def _project_containers():
    """All containers of this compose project (running or not)."""
    return _docker().containers.list(
        all=True,
        filters={"label": f"com.docker.compose.project={COMPOSE_PROJECT}"},
    )


def _service_name(container) -> str:
    return container.labels.get("com.docker.compose.service", container.name)


def _find_container(service: str):
    for c in _project_containers():
        if _service_name(c) == service:
            return c
    raise HTTPException(status_code=404, detail=f"service '{service}' not found")


def _mem_cpu(container) -> tuple[float | None, float | None, float | None]:
    """(cpu_percent, mem_used_mb, mem_limit_mb) from a one-shot stats read."""
    try:
        s = container.stats(stream=False)
        cpu_delta = (s["cpu_stats"]["cpu_usage"]["total_usage"]
                     - s["precpu_stats"]["cpu_usage"]["total_usage"])
        sys_delta = (s["cpu_stats"].get("system_cpu_usage", 0)
                     - s["precpu_stats"].get("system_cpu_usage", 0))
        ncpu = s["cpu_stats"].get("online_cpus") or 1
        cpu = (cpu_delta / sys_delta) * ncpu * 100.0 if sys_delta > 0 else 0.0
        mem = s["memory_stats"].get("usage")
        lim = s["memory_stats"].get("limit")
        return (round(cpu, 1),
                round(mem / 1048576, 1) if mem else None,
                round(lim / 1048576, 1) if lim else None)
    except Exception:
        return (None, None, None)


# ── Services ──────────────────────────────────────────────────────

# The ops service must not restart itself or the proxy that carries the
# admin's own request (it would cut the response off mid-flight).
PROTECTED_SERVICES = {"ops_backend", "proxy", "dev_proxy"}


@app.get("/services")
async def list_services(stats: bool = False, _: dict = Depends(RequireAdmin)):
    """Without ?stats=1 this is a single fast Docker list call. With stats,
    the per-container stats reads (~1s each: Docker samples CPU twice) run in
    a thread pool in PARALLEL — serially they'd take ~1s × n_containers.
    Everything runs off the event loop (docker-py is blocking)."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    def build():
        containers = _project_containers()
        stats_map: dict[str, tuple] = {}
        if stats:
            running = [c for c in containers if c.status == "running"]
            if running:
                with ThreadPoolExecutor(max_workers=min(16, len(running))) as ex:
                    stats_map = dict(ex.map(lambda c: (c.id, _mem_cpu(c)), running))
        out = []
        for c in containers:
            name = _service_name(c)
            cpu, mem, lim = stats_map.get(c.id, (None, None, None))
            out.append({
                "service": name,
                "container": c.name,
                "status": c.status,                  # running / exited / restarting…
                "health": (c.attrs.get("State", {}).get("Health", {}) or {}).get("Status"),
                "started_at": c.attrs.get("State", {}).get("StartedAt"),
                # NB: c.attrs only — c.image would cost one extra API call per container
                "image": c.attrs.get("Config", {}).get("Image"),
                "restartable": name not in PROTECTED_SERVICES,
                "cpu_percent": cpu,
                "mem_used_mb": mem,
                "mem_limit_mb": lim,
            })
        out.sort(key=lambda x: x["service"])
        return out

    services = await asyncio.to_thread(build)
    return {"project": COMPOSE_PROJECT, "services": services}


@app.post("/services/{service}/restart")
async def restart_service(service: str, admin: dict = Depends(RequireAdmin)):
    import asyncio
    if service in PROTECTED_SERVICES:
        raise HTTPException(status_code=400,
                            detail=f"'{service}' cannot be restarted from here")
    c = _find_container(service)
    logger.info("admin %s restarts service %s", admin.get("sub"), service)
    await asyncio.to_thread(c.restart, timeout=20)
    return {"ok": True, "service": service}


@app.get("/services/{service}/logs")
async def service_logs(service: str, tail: int = 200, since: float | None = None,
                       _: dict = Depends(RequireAdmin)):
    """Log tail. With ?since=<unix ts> only lines after that moment are
    returned — the frontend polls this for a live follow view."""
    import asyncio
    tail = max(10, min(int(tail), 2000))
    c = _find_container(service)
    kwargs = {"timestamps": True}
    if since:
        kwargs["since"] = float(since)
    else:
        kwargs["tail"] = tail
    raw = await asyncio.to_thread(lambda: c.logs(**kwargs))
    return {"service": service, "tail": tail,
            "now": __import__("time").time(),
            "logs": raw.decode("utf-8", errors="replace")}


# ── Environment (.env) editor ─────────────────────────────────────

# Keys an admin may edit from the UI, with a hint which services need a
# restart for the change to take effect. Secrets are maskable but editable.
EDITABLE_KEYS: dict[str, dict] = {
    "DUCKDB_MEMORY_LIMIT":        {"restart": ["webmap_backend"], "hint": "e.g. 4GB — empty = ~80% of RAM"},
    "DUCKDB_THREADS":             {"restart": ["webmap_backend"], "hint": "e.g. 4 — empty = all cores"},
    "WEBMAP_PREWARM":             {"restart": ["webmap_backend"], "hint": "1 = warm caches at startup"},
    "UVICORN_WORKERS":            {"restart": ["webmap_backend", "dataset_backend", "authentification_backend"], "hint": "worker processes per backend (prod images)"},
    "ACCESS_TOKEN_MINUTES":       {"restart": ["authentification_backend", "webmap_backend", "dataset_backend"], "hint": "access-token lifetime"},
    "REFRESH_TOKEN_DAYS":         {"restart": ["authentification_backend"], "hint": "refresh-token lifetime"},
    "DEV_MODE":                   {"restart": ["authentification_backend"], "hint": "1 = dev account may log in"},
    "REQUIRE_EMAIL_VERIFICATION": {"restart": ["authentification_backend"], "hint": "1 = registration needs mailed link"},
    "REQUIRE_ADMIN_APPROVAL":     {"restart": ["authentification_backend"], "hint": "1 = admin must approve new accounts"},
    "PUBLIC_BASE_URL":            {"restart": ["authentification_backend"], "hint": "origin used in verification links"},
    "SMTP_HOST":                  {"restart": ["authentification_backend"], "hint": "empty = log links instead of mailing"},
    "SMTP_PORT":                  {"restart": ["authentification_backend"], "hint": ""},
    "SMTP_USER":                  {"restart": ["authentification_backend"], "hint": ""},
    "SMTP_PASSWORD":              {"restart": ["authentification_backend"], "hint": "", "secret": True},
    "SMTP_FROM":                  {"restart": ["authentification_backend"], "hint": ""},
    "AI_QUERY_ENABLED":           {"restart": ["webmap_backend"], "hint": "1 = show the Ask-AI chat (needs a key too)"},
    "LLM_PROVIDER":               {"restart": ["webmap_backend"], "hint": "gemini or openai (OpenAI-compatible, e.g. Ollama)"},
    "GEMINI_API_KEY":             {"restart": ["webmap_backend"], "hint": "Gemini key for Ask-AI", "secret": True},
    "LLM_MODEL":                  {"restart": ["webmap_backend"], "hint": "e.g. gemini-2.5-flash or llama3.3"},
    "LLM_BASE_URL":               {"restart": ["webmap_backend"], "hint": "OpenAI-compatible endpoint (LLM_PROVIDER=openai)"},
    "LLM_API_KEY":                {"restart": ["webmap_backend"], "hint": "key for LLM_BASE_URL", "secret": True},
    "SIM_WORKER_TOKEN":           {"restart": ["sim_backend"], "hint": "shared secret for sim workers", "secret": True},
    "SIM_MAX_ACTIVE_PER_USER":    {"restart": ["sim_backend"], "hint": "queued+running quota per user"},
}

_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def _read_env() -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        with open(ENV_FILE) as f:
            for line in f:
                m = _KEY_RE.match(line.strip())
                if m:
                    values[m.group(1)] = m.group(2)
    except FileNotFoundError:
        pass
    return values


def _write_env(updates: dict[str, str]) -> None:
    """Update keys in place, preserving comments/order; append new keys."""
    try:
        with open(ENV_FILE) as f:
            lines = f.readlines()
    except FileNotFoundError:
        lines = []
    remaining = dict(updates)
    out = []
    for line in lines:
        m = _KEY_RE.match(line.strip())
        if m and m.group(1) in remaining:
            out.append(f"{m.group(1)}={remaining.pop(m.group(1))}\n")
        else:
            out.append(line)
    if remaining:
        if out and not out[-1].endswith("\n"):
            out[-1] += "\n"
        out.append("\n# ── set via admin panel ──\n")
        for k, v in remaining.items():
            out.append(f"{k}={v}\n")
    with open(ENV_FILE, "w") as f:
        f.writelines(out)


class EnvUpdate(BaseModel):
    values: dict[str, str]


@app.get("/env")
async def get_env(_: dict = Depends(RequireAdmin)):
    current = _read_env()
    out = []
    for key, meta in EDITABLE_KEYS.items():
        val = current.get(key, "")
        secret = bool(meta.get("secret"))
        out.append({
            "key": key,
            "value": "•••••" if (secret and val) else val,
            "secret": secret,
            "hint": meta.get("hint", ""),
            "restart": meta.get("restart", []),
        })
    return {"env_file": ENV_FILE, "keys": out}


@app.put("/env")
async def put_env(body: EnvUpdate, admin: dict = Depends(RequireAdmin)):
    unknown = [k for k in body.values if k not in EDITABLE_KEYS]
    if unknown:
        raise HTTPException(status_code=422,
                            detail=f"not editable: {', '.join(sorted(unknown))}")
    # Never write the mask back over a real secret
    clean = {k: v for k, v in body.values.items() if v != "•••••"}
    if not clean:
        return {"ok": True, "changed": [], "restart": []}
    _write_env(clean)
    logger.info("admin %s changed env keys: %s", admin.get("sub"), ", ".join(clean))
    restart = sorted({s for k in clean for s in EDITABLE_KEYS[k]["restart"]})
    return {"ok": True, "changed": sorted(clean), "restart": restart}


@app.get("/health")
async def health():
    return {"status": "ok", "env": ENV}

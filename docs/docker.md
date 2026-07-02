# Docker & Deployment Modes

## File layout

```
docker-compose.yml        # base stack: prod images from GHCR, nginx proxy
proxy/
  nginx.conf              # top-level nginx config (prod proxy)
  prod.conf               # routing/rewrites (see Architecture → URL namespace)
dev/
  all.yml                 # overlay: EVERYTHING in dev mode (vite proxy + hot reload)
  proxy.yml               # overlay: only swap nginx → vite dev proxy
  webmap-backend.yml      # overlay: only this service in dev mode
  …one file per service…  # (all.yml contains verbatim copies — keep in sync!)
dev-proxy/                # the vite-based dev proxy (its own tiny container)
```

The base file always defines the full stack with **prod images**; `dev/*.yml`
files are compose **overlays** that switch individual services to a locally
built dev image with bind-mounted source. Mix and match:

```bash
# Everything prod (GHCR images):
docker compose -f docker-compose.yml up -d

# Everything dev (hot reload everywhere):
docker compose -f docker-compose.yml -f dev/all.yml up --build

# Work on ONE service, rest stays prod:
docker compose -f docker-compose.yml -f dev/proxy.yml -f dev/webmap-backend.yml up
```

The nginx proxy is disabled in dev via a compose *profile* trick: the overlay
puts `proxy` into `profiles: [nginx]`, so it only starts when that profile is
explicitly requested, and `dev_proxy` takes over port 80.

## Dev vs prod

| | prod | dev |
|---|---|---|
| Images | `ghcr.io/matsim-eth/webmap/*:latest` | built locally (`target: dev`) |
| Proxy | nginx (`proxy/prod.conf`) | vite dev server (`dev-proxy/vite.config.js`) |
| Frontends | static build in nginx (:5021/:5023) | vite dev server + HMR (:5121/:5122) |
| Backends | uvicorn, 4 workers | uvicorn `--reload`, 1 worker, source bind-mounted |
| Code changes | rebuild image (CI does this on push) | picked up live (backend reload / vite HMR) |

**Dev specifics**

* Backend source is bind-mounted (`./webmap-backend:/app`) → after `git pull`
  a `docker compose … restart webmap_backend` is enough; `--build` is only
  needed when `requirements.txt` / `package.json` change.
* Frontends keep `node_modules` in a **named volume** so the host directory
  doesn't need an install; `CHOKIDAR_USEPOLLING` makes file-watching work
  through the bind mount.
* All three vite servers (dev proxy + both frontends) set `allowedHosts: true`
  — vite otherwise rejects requests whose `Host` header isn't localhost, which
  breaks access via a server hostname.
* HMR websockets ride through the proxy (`ws: true`, `clientPort: 80`).

## The two proxies

**Prod: nginx** (`proxy/prod.conf`)

* Strips service prefixes with `rewrite … break` (see Architecture).
* `/backend/datasets/`: `client_max_body_size 0` + `proxy_request_buffering
  off` + 1 h timeouts — dataset uploads are whole DuckDB files (5–15 GB) and
  are streamed straight through to the dataset backend.
* `/backend/`: `proxy_read_timeout 300s` — a cold DuckDB scan (first
  `speed_dashboard` on a 15 GB file) can exceed the 60 s nginx default.

**Dev: vite** (`dev-proxy/vite.config.js`)

* Same path table expressed as vite `server.proxy` entries; backend prefixes
  are rewritten away, frontend prefixes are passed through (the frontends'
  own vite servers serve under their `base` path).
* Also proxies websockets (HMR for both frontends).

**Frontend prod images.** Vite builds with `base: '/webmap/'` (resp.
`/dashboard/`) and the proxy forwards the *full* path, so the prod images
place the bundle under `/usr/share/nginx/html/webmap` (resp. `dashboard`) and
ship their own nginx config listening on 5021/5023
(`<frontend>/webconfig/frontend_prod.conf`) with an SPA fallback to
`<base>/index.html` and immutable caching for hashed assets.

## Health & startup order

The three FastAPI backends expose `GET /health` and have compose healthchecks
(python urllib — the slim images have no curl). Startup chain:

```
postgres (healthy) → auth/dataset backends (healthy) → webmap backend (healthy) → proxy
```

Frontends are static/vite and only gated on `service_started`. In dev the
`dev_proxy` intentionally uses `service_started` so the stack comes up fast.

## Volumes & data

All persistent state lives in bind-mounted directories under `./data/` (git-ignored):

| Volume | Host path | Used by |
|---|---|---|
| `auth_db_data` | `data/auth-database` | auth postgres |
| `dataset_db_data` | `data/dataset-database` | dataset postgres |
| `dataset_storage` | `data/dataset-storage` | dataset backend (rw), **webmap backend (read-only)** |

Datasets live at `data/dataset-storage/public/{id}/…` — the webmap backend
mounts the whole tree read-only; only the dataset service writes.

## CI → GHCR

Each service has a GitHub Actions workflow
(`.github/workflows/build-*.yml`) that is **path-filtered**: pushing to `main`
with changes under `webmap-backend/**` rebuilds only
`ghcr.io/matsim-eth/webmap/webmap-backend` (tags: `latest` + commit SHA,
`target: prod`). Pull requests build without pushing. A prod server therefore
updates with:

```bash
docker compose -f docker-compose.yml pull && docker compose -f docker-compose.yml up -d
```

## Command cookbook

```bash
# logs (follow, one service)
docker compose -f docker-compose.yml -f dev/all.yml logs -f --no-color webmap_backend

# restart backend after a git pull (dev, bind-mounted source)
docker compose -f docker-compose.yml -f dev/all.yml restart webmap_backend

# rebuild after dependency changes
docker compose -f docker-compose.yml -f dev/all.yml up -d --build webmap_backend

# run a one-off python inside the backend (e.g. inspect a duckdb)
docker exec webmap-webmap_backend-1 python3 -c "import duckdb; ..."

# start the prod nginx proxy even in dev (profile trick)
docker compose -f docker-compose.yml -f dev/all.yml --profile nginx up proxy

# validate compose files after editing
docker compose -f docker-compose.yml -f dev/all.yml config -q
```

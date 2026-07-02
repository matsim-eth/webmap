# Webmap — Developer Wiki

Documentation for the MATSim webmap platform: a multi-service web application for
exploring MATSim transport-simulation results (interactive map + statistics
dashboard) against the Swiss Mikrozensus as a real-world reference.

## Pages

| Page | Contents |
|---|---|
| [Architecture](architecture.md) | Services, URL namespace, ports, request flow, dataset model |
| [Docker & Deployment Modes](docker.md) | Compose layout, dev vs prod, the two proxies, CI/GHCR, command cookbook |
| [Tutorial: New Feature End-to-End](tutorial-new-feature.md) | **Step-by-step**: DuckDB query → backend provider → test → dashboard chart → deploy |
| [Webmap Backend](webmap-backend.md) | FastAPI app, provider pattern, adding a route (incl. **authenticated routes**), caching, special endpoints |
| [Authentication & Authorization](authentication.md) | JWT/cookie model, auth service endpoints, dataset permissions, dev mode |
| [DuckDB Dataset Format](duckdb-format.md) | The data contract with the eqasim pipeline: every table, every static asset, conventions |
| [Setup & Operations](setup-deployment.md) | Local setup, server deployment, dataset upload, troubleshooting |

## 60-second orientation

```
Browser ──:80──▶ proxy ──▶ /webmap/     → webmap-frontend    (React + Mapbox map)
                        ──▶ /dashboard/  → dashboard-frontend (React + Plotly charts)
                        ──▶ /backend/    → webmap-backend     (FastAPI: all chart/map data, reads DuckDB)
                        ──▶ /backend/datasets/ → dataset-backend (FastAPI: dataset registry + storage)
                        ──▶ /authentification/         → auth-frontend (login page + admin panel)
                        ──▶ /authentification/backend/ → auth-backend  (JWT auth)
```

* Every piece of data shown in the map or dashboard comes from
  **one or two DuckDB files per dataset** (`synthetic.duckdb`, `microcensus.duckdb`),
  produced by the eqasim pipeline and stored under `data/dataset-storage/public/{id}/`.
* The webmap backend serves ~35 JSON endpoints (`/backend/data/{dataset_id}/…`),
  each implemented as a small `DataProvider` class — see
  [Webmap Backend → Adding a new route](webmap-backend.md#adding-a-new-route).
* Everything runs in Docker Compose. Two modes:
  `docker compose -f docker-compose.yml up` (prod images from GHCR) and
  `… -f dev/all.yml up --build` (hot-reload dev) — see [Docker](docker.md).

## Quick start (dev)

```bash
cp .env.example .env                # adjust if needed
docker compose -f docker-compose.yml -f dev/all.yml up --build
# put a dataset in data/dataset-storage/public/1/ (synthetic.duckdb [+ microcensus.duckdb])
open http://localhost/webmap/       # dev login: dev@local / dev  (DEV_MODE=1)
```

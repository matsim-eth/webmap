# Setup & Operations

## Local setup

```bash
git clone git@github.com:matsim-eth/webmap.git && cd webmap
cp .env.example .env        # then edit — see table below
docker compose -f docker-compose.yml -f dev/all.yml up --build
```

Put at least one dataset in place (see *Datasets* below), then open
`http://localhost/webmap/`. With `DEV_MODE=1` log in as `dev@local` / `dev`.

### .env variables

| Var | Purpose |
|---|---|
| `VITE_MAPBOX_TOKEN` | Mapbox GL token for both frontends (dev mode) |
| `DEV_MODE` / `ENV` | `1`/`dev` seeds + allows the dev account; set `0`/`prod` on servers |
| `JWT_SECRET` | shared signing secret for all backends — **change in prod** |
| `ACCESS_TOKEN_MINUTES`, `REFRESH_TOKEN_DAYS` | token lifetimes |
| `AUTH_DB_*`, `DATASET_DB_*` | postgres credentials (compose-internal) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | admin account seeded at startup |
| `WEBMAP_ROOT` | fallback dataset root inside the backend container |

## Server deployment (dev-mode stack, e.g. idsc-rudolf)

The ETH deployment currently runs the **dev overlay** (bind-mounted source →
update = `git pull` + restart, no image rebuilds):

```bash
ssh <user>@<server>
cd ~/webmap/webmap
git pull origin main
docker compose -f docker-compose.yml -f dev/all.yml up -d
```

**Update to newest code:**

```bash
cd ~/webmap/webmap && git pull origin main \
  && docker compose -f docker-compose.yml -f dev/all.yml restart \
       webmap_backend dashboard_frontend webmap_frontend dev_proxy
```

then hard-refresh the browser (Cmd/Ctrl+Shift+R). `--build` is only needed when
`requirements.txt`/`package.json` changed.

**Pure prod alternative** (GHCR images, built by CI on every push to main):

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
```

Note: the ETH firewall may block direct access to port 80/8080 from outside —
use an SSH tunnel for testing: `ssh -L 8080:localhost:80 <user>@<server>`,
then browse `http://localhost:8080/webmap/`.

## Datasets

### Directory layout & registry

```
data/dataset-storage/public/{id}/synthetic.duckdb
data/dataset-storage/public/{id}/microcensus.duckdb
```

The **directory name is the dataset id** and must match a row in the dataset
service's Postgres (`datasets` table: name, slug, status=`active`,
`is_public`). Datasets are created/uploaded via the **admin panel**
(`/authentification/admin/`); the file format is specified in
[duckdb-format.md](duckdb-format.md).

### Getting files onto a server

Admin-panel upload streams through the proxy (no size cap). For very large
files, `scp`/`rsync` directly into the storage directory also works:

```bash
rsync -avP synthetic.duckdb <user>@<server>:webmap/webmap/data/dataset-storage/public/1/
```

* `rsync -avP` can **resume** an interrupted transfer; plain `scp` cannot.
* Verify afterwards — a truncated DuckDB fails with
  `IO Error: Could not read enough bytes`:
  ```bash
  docker exec webmap-webmap_backend-1 python3 - <<'EOF'
  import duckdb
  c = duckdb.connect('/data/datasets/public/1/synthetic.duckdb', read_only=True)
  print(c.execute('SELECT COUNT(*) FROM spider_link_index').fetchone())
  print(c.execute("SELECT payload FROM static_assets WHERE key='metadata'").fetchone())
  EOF
  ```
* Replacing a file on disk is picked up automatically (caches are keyed by a
  file-content signature); a `restart webmap_backend` is the safe hammer if
  anything looks stale.
* If a `public/{id}` directory was created **by a container as root**, your
  ssh user cannot delete its contents. You *can* rename it (rename needs only
  parent-dir permission): `mv 2 2_old_root && mkdir 2`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Vite: `Blocked request. This host … is not allowed` | A vite server without `allowedHosts: true`. There are **three** (dev-proxy + both frontends) — all must have it. |
| First Speed/Transit request takes ~30 s after restart | Cold-cache build; the prewarm thread does it in the background at startup — wait a minute, or check `logs webmap_backend` for `prewarmed …`. |
| `IO Error: Could not read enough bytes` | Truncated/incomplete DuckDB file (interrupted upload, or reading while a copy is still running). Re-transfer, verify with the snippet above. |
| Chart shows a source with all-zero bars / a source missing | The underlying column is NULL in that source's DuckDB → backend omits the source by design. Fix the data (see duckdb-format.md → microcensus columns). |
| `Binder Error: column "freespeed" not found` | Old-schema `link_speeds` (pre-v2, single `speed` column). Replace with a current pipeline build. |
| 1% and 5% runs show identical numbers | The two dataset dirs contain the same duckdb (check `static_assets.metadata` → `run_name`), or a stale fixed-reference fallback — both frontends must load from `/backend/data/{id}/…`, never from a static CDN. |
| Upload via admin panel fails for multi-GB files | Only on old proxy configs (`client_max_body_size 500m`); current `proxy/prod.conf` streams unlimited. |
| Permission denied writing `public/{id}` | Directory root-owned (created by container) — `mv` it aside and `mkdir` fresh (see above). |
| 401 loops | `JWT_SECRET` mismatch between auth and the other backends; or cookies from another instance — clear cookies. |

## Where things are logged

```bash
docker compose -f docker-compose.yml -f dev/all.yml logs -f --no-color webmap_backend
# to a file for sharing:
docker compose … logs --no-color --timestamps webmap_backend > ~/backend.log 2>&1
```

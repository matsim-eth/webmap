# Webmap Backend

FastAPI service that turns per-dataset DuckDB files into the JSON consumed by
the map and the dashboard. Stateless — no own database, everything is derived
from the dataset files plus in-memory caches.

## Layout

```
webmap-backend/
  main.py                    # app, auth middleware, lifespan (cache prewarm),
                             # /health, and the special /data/{id}/matsim/* routes
  providers/
    __init__.py              # ALL_PROVIDERS — the endpoint registry
    base.py                  # DataProvider ABC, Param, mount_provider(), dataset resolution
    paths.py                 # dataset root resolution (ContextVar), dataset_key()
    connection.py            # pooled read-only DuckDB cursors (spatial ext. loaded)
    helpers.py               # canton resolution, static_assets loaders, filters
    _pre_agg.py              # shared builders for the pre-aggregated hot_polygon/hex tables
    constants.py             # CANTON_MAP (1..26 → name), purposes, subscriptions…
    <domain>.py              # one file per endpoint family (age, trips, spider, …)
```

## Request lifecycle

1. `AuthMiddleware` checks the `access_token` JWT cookie (skipped for
   `/health`, docs, and entirely when `LOCAL_RUN=1`).
2. Route `/data/{dataset_id}/<ROUTE>` (registered by `mount_provider`):
   * resolves `dataset_id` → filesystem root via the dataset service
     (`GET /datasets/{id}/resolve`, cached per dataset+user),
   * stores the root in a **ContextVar** (`paths.set_root_override`) — every
     helper (`get_data_paths`, `get_source_cursor`, `dataset_key`) reads it
     transparently, and it is async-safe per request,
   * runs `provider.deliver(params)` in a worker thread (`asyncio.to_thread` —
     DuckDB calls block, the event loop must not),
   * post-processes: with `?canton=` the redundant `"All"` key is stripped;
     with `?summary_only=1` only `"All"` is returned,
   * on any provider exception returns `{"error": "..."}` with HTTP 200 —
     an incompatible/older dataset must degrade, never 500.
3. `finally: set_root_override(None)`.

## The provider pattern

Every JSON endpoint is a subclass of `DataProvider`:

```python
class DataProvider(ABC):
    ROUTE: str                  # filename, e.g. "age.json" → /data/{id}/age.json
    PARAMS: list[Param] = []    # query params, for OpenAPI docs
    def deliver(self, params: dict) -> dict: ...
```

`params` are the **raw query strings**. The conventional response shape for
dashboard charts is:

```json
{ "<label>": { "<Source>": { ...payload... } } }
```

where `label` is a canton name / polygon label / `"All"`, and `Source` is
`Synthetic` / `Microcensus`. Conventions that keep the frontend working:

* **Omit, don't zero.** If a source has no data for a label (column not
  populated, table missing), leave the source out instead of emitting all-zero
  series — the dashboard renders whatever it receives.
* **Comparable categories.** When a chart compares sources over a top-N of
  categories, rank once across sources and return the *same* category set for
  every source (see `frequent_sequences.py`), otherwise bars appear "missing".
* **Errors** are `{"error": "human readable reason"}` — the frontend treats
  that as "no data" and falls back cleanly.

## Adding a new route

Example: a `vehicle_km.json` endpoint returning vehicle-kilometres per canton.

**1. Create `providers/vehicle_km.py`:**

```python
"""Vehicle-kilometres per canton (from link_speeds × network_links.length)."""
from __future__ import annotations

from .base import DataProvider, Param, CANTON, SOURCE
from .connection import get_source_cursor
from .constants import canton_name
from .paths import dataset_key

# Per-dataset result cache. ALWAYS key on dataset_key(): it contains the
# resolved root AND a content signature of the duckdb files, so several
# datasets served by one worker never mix, and replacing a file on disk
# invalidates automatically.
_cache: dict[tuple, dict] = {}


class VehicleKmProvider(DataProvider):
    ROUTE = "vehicle_km.json"
    PARAMS = [
        CANTON,                                   # reusable common Params exist in base.py
        Param("minute_start", "Window start (min from midnight)", param_type="integer"),
        Param("minute_end", "Window end (min from midnight)", param_type="integer"),
    ]

    def deliver(self, params: dict) -> dict:
        key = (dataset_key(), params.get("canton"),
               params.get("minute_start"), params.get("minute_end"))
        if key in _cache:
            return _cache[key]

        con = get_source_cursor("synthetic")      # pooled, read-only, spatial loaded
        clauses, bind = ["1=1"], []
        if params.get("minute_start"):
            clauses.append("ls.time_bin >= ?"); bind.append(int(params["minute_start"]) // 15)
        if params.get("minute_end"):
            clauses.append("ls.time_bin < ?");  bind.append((int(params["minute_end"]) + 14) // 15)

        rows = con.execute(f"""
            SELECT ls.canton_id, SUM(ls.volume * nl.length) / 1000.0
            FROM link_speeds ls JOIN network_links nl USING (link_id)
            WHERE {' AND '.join(clauses)}
            GROUP BY ls.canton_id
        """, bind).fetchall()

        out = {canton_name(cid): {"Synthetic": {"vehicle_km": round(vkm, 1)}}
               for cid, vkm in rows if cid is not None}
        out["All"] = {"Synthetic": {"vehicle_km": round(sum(v for _, v in rows), 1)}}
        _cache[key] = out
        return out
```

**2. Register it in `providers/__init__.py`:**

```python
from .vehicle_km import VehicleKmProvider
ALL_PROVIDERS = [
    ...,
    VehicleKmProvider(),
]
```

That's it — `main.py` mounts every entry of `ALL_PROVIDERS` via
`mount_provider(app, provider, prefix="/data")`, which generates the
`/data/{dataset_id}/vehicle_km.json` route including OpenAPI docs from
`PARAMS`. No FastAPI code needed.

**3. Test without the HTTP stack:**

```python
from providers.paths import set_root_override
set_root_override("/path/to/data/dataset-storage/public/1")
from providers.vehicle_km import VehicleKmProvider
print(VehicleKmProvider().deliver({"canton": "Zurich"}))
```

**Guidelines**

* Query with `get_source_cursor("synthetic"|"microcensus")` — never open
  DuckDB files yourself; the pool handles read-only mode, the spatial
  extension, and file-replacement invalidation.
* For big `IN`-lists use `WHERE x IN (SELECT UNNEST(?))` with one bound list —
  one scan instead of N chunked queries.
* If the first call is expensive (seconds), guard the build with a lock
  (thundering-herd — see `transit_stops.py`) and consider adding it to the
  startup prewarm in `main.py::_prewarm_caches`.
* Filter params: reuse `helpers` (canton resolution accepts names, umlauts,
  IDs; `polygon_ids_from_params`; gender/age SQL fragments).
* Geometry: DuckDB tables store LV95; transform per query with
  `ST_Transform(geom, 'EPSG:2056', 'EPSG:4326', always_xy := true)`.

## Adding an authenticated route

Providers are **already authenticated**: the blanket `AuthMiddleware` rejects
any request without a valid `access_token` cookie, and the dataset resolution
step enforces per-dataset permissions (public / owner — see
[authentication.md](authentication.md)). You only need explicit auth code when
a route must know *who* is calling or restrict itself to admins.

**Example: a per-user endpoint with an admin-only variant** (add to `main.py`,
or a router module imported from it):

```python
from fastapi import Request, HTTPException

@app.get("/data/{dataset_id}/my_query_quota.json")
async def my_query_quota(dataset_id: int, request: Request):
    # OptionalUser (defined in main.py) decodes the JWT cookie and returns its
    # claims — or raises 401. With LOCAL_RUN=1 it returns a stub local user.
    user = await OptionalUser(request)

    # access-token claims: sub (user id, str), admin (bool), typ, exp
    user_id = int(user.get("sub") or 0)
    is_admin = bool(user.get("admin"))

    if not is_admin and int(request.query_params.get("limit", 0)) > 1000:
        raise HTTPException(status_code=403, detail="limit reserved for admins")

    return {"user_id": user_id, "admin": is_admin, "dataset": dataset_id}
```

What to use when:

| Need | Do this |
|---|---|
| Route just serves data | Nothing — the middleware already guards it |
| Know the calling user | `user = await OptionalUser(request)` → claims (`sub`, `admin`) |
| Per-dataset permission | Resolve through the dataset service: `await _resolve_dataset_root(dataset_id, user_id, request.cookies.get("access_token",""))` (from `providers.base`) — raises if the user may not access the dataset |
| Admin-only | Check the role claim from `OptionalUser` and raise `HTTPException(403)` (the claim is set by the auth service at login) |
| Call another service as the user | Forward the cookie: `cookies={"access_token": request.cookies.get("access_token","")}` — exactly what `_resolve_dataset_root` does |

Two things **not** to do: don't add per-route `Depends(RequireUser())` here
(that's the AuthAPI/DB-backed pattern of the auth & dataset services — the
webmap backend validates statelessly), and don't skip the dataset resolve for
routes that read dataset files, otherwise you bypass dataset permissions.

Testing: with `LOCAL_RUN=1` auth is stubbed (local user, id 0). For real-token
tests, log in via the auth service and reuse the cookie:

```bash
curl -s -c /tmp/jar -X POST http://localhost/authentification/backend/login \
     -H 'Content-Type: application/json' \
     -d '{"identifier":"dev@local","password":"dev"}' > /dev/null
curl -s -b /tmp/jar http://localhost/backend/data/1/my_query_quota.json
```

## Special endpoints (not providers)

* `GET /health` — liveness, used by the compose healthcheck.
* `GET /data/{id}/matsim/{path}` (`main.py::matsim_asset`) — legacy-shaped
  asset paths the frontends request, reconstructed from the DuckDB:
  * `matsim/{Canton}_merged_segments.geojson` → `static_assets` key `merged_segments:{cid}`
  * `matsim/transit/routes/transit_routes.geojson` → key `transit_routes`
  * `matsim/transit/stops_by_canton/{Canton}_stops.geojson` → built by `providers/transit_stops.py`
  * `matsim/transit/per_canton_counts/{Canton}_counts.json` → built from `boarding_data_by_line`
  * `matsim/transit/transit_modes_by_canton.json`, `…/inter_cantonal_stops.geojson`
  Unknown paths → 404 (the frontend then falls back / shows empty).

## Caching layers

| Layer | Key | Invalidation |
|---|---|---|
| DuckDB connection pool (`connection.py`) | file path | file replaced on disk |
| Per-dataset asset caches (boarding data, transit stops, transfers, …) | `dataset_key()` | key embeds file mtime+size signature → automatic |
| Result LRU (`link_speeds.py`) | route + `dataset_key()` + params | LRU bound (24) + signature |
| Dataset-root resolve cache (`base.py`) | (dataset_id, user_id) | process lifetime |

**Prewarm** (`main.py::_prewarm_caches`, daemon thread at startup, disable with
`WEBMAP_PREWARM=0`): per dataset it precomputes the two expensive cold builds —
`speed_dashboard` (a full `link_speeds` scan) and the country-wide transit-stop
bundle — so the first user never waits for them.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `WEBMAP_ROOT` | `/data/datasets/public` | Fallback dataset root when no `{dataset_id}` resolution happens |
| `DATASET_SERVICE_URL` | `http://dataset_backend:5033` | Resolve endpoint |
| `LOCAL_RUN` | `0` | `1` disables auth (local provider testing) |
| `JWT_SECRET` | — | must match the auth service |
| `WEBMAP_PREWARM` | `1` | startup cache prewarm on/off |
| `ROOT_PATH` | `/backend` | public prefix (proxy strips it) |
| `CORS_ORIGINS` | empty | extra allowed origins (same-origin via proxy needs none) |

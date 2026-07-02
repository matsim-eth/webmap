# Tutorial: Implementing a New Feature End-to-End

Worked example — we add **"Average trip duration per canton"** as a new
dashboard chart, from DuckDB query to deployed UI. Adapting the steps to a map
feature is sketched at the end.

## 0. Prerequisites

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f dev/all.yml up --build -d
# a dataset must exist, e.g. data/dataset-storage/public/1/synthetic.duckdb
```

Everything below hot-reloads: backend edits restart uvicorn automatically,
frontend edits HMR into the browser.

## 1. Explore the data first

Find your numbers in the DuckDB before writing any code:

```bash
docker exec -it webmap-webmap_backend-1 python3 - <<'EOF'
import duckdb
c = duckdb.connect('/data/datasets/public/1/synthetic.duckdb', read_only=True)
print(c.execute("""
    SELECT origin_canton_id, ROUND(AVG(travel_time)/60, 1) AS avg_min, COUNT(*)
    FROM trips GROUP BY 1 ORDER BY 1 LIMIT 5
""").fetchall())
EOF
```

Check the same query against `microcensus.duckdb` — if both sources have the
data, the chart can compare them (see [duckdb-format.md](duckdb-format.md)).

## 2. Write the provider

Create `webmap-backend/providers/trip_duration.py`:

```python
"""Average trip duration per canton and source."""
from __future__ import annotations

from .base import DataProvider, CANTON, SOURCE, MODE
from .connection import get_source_cursor
from .constants import canton_name
from .helpers import parse_source_param
from ._pre_agg import _source_label
from .paths import dataset_key

_cache: dict[tuple, dict] = {}


class TripDurationProvider(DataProvider):
    ROUTE = "trip_duration.json"                     # → /data/{id}/trip_duration.json
    PARAMS = [CANTON, SOURCE, MODE]

    def deliver(self, params: dict) -> dict:
        key = (dataset_key(), params.get("mode"))
        if key in _cache:
            return _cache[key]

        clauses, bind = ["travel_time IS NOT NULL"], []
        if params.get("mode"):
            modes = [m.strip() for m in params["mode"].split(",") if m.strip()]
            clauses.append(f"main_mode IN ({','.join('?' * len(modes))})")
            bind.extend(modes)
        where = " AND ".join(clauses)

        out: dict = {}
        for source in parse_source_param(params):    # ['synthetic', 'microcensus']
            try:
                con = get_source_cursor(source)
            except Exception:
                continue                             # file missing → omit source
            slabel = _source_label(source)

            rows = con.execute(f"""
                SELECT origin_canton_id, AVG(travel_time) / 60.0, COUNT(*)
                FROM trips WHERE {where}
                GROUP BY GROUPING SETS ((origin_canton_id), ())
            """, bind).fetchall()

            for cid, avg_min, n in rows:
                if not n:
                    continue                         # omit empty, never zero-fill
                label = canton_name(cid) if cid is not None else "All"
                out.setdefault(label, {})[slabel] = {"avg_duration_min": round(avg_min, 1)}

        _cache[key] = out
        return out
```

Rules that keep this consistent with the rest of the backend:

* response shape `{label: {Source: payload}}`; **omit** a source with no data,
* cache keyed on `dataset_key()` (never on nothing — workers serve many datasets),
* raw query params in, plain dict out; exceptions are fine (the mount wrapper
  converts them to `{"error": …}`).

## 3. Register it

`webmap-backend/providers/__init__.py`:

```python
from .trip_duration import TripDurationProvider
ALL_PROVIDERS = [
    ...,
    TripDurationProvider(),
]
```

The route now exists — `mount_provider` generated it, uvicorn already reloaded.

## 4. Test

Pure-python (no HTTP, no auth):

```bash
docker exec webmap-webmap_backend-1 python3 - <<'EOF'
from providers.paths import set_root_override
set_root_override('/data/datasets/public/1')
from providers.trip_duration import TripDurationProvider
r = TripDurationProvider().deliver({})
print(r.get("All"), "| labels:", len(r))
EOF
```

Through the full stack (auth + proxy + dataset resolution) — log in at
`http://localhost/authentification/` (dev: `dev@local`/`dev`), then:

```
http://localhost/backend/data/1/trip_duration.json?mode=car
```

Expect `{"Zurich": {"Synthetic": {...}, "Microcensus": {...}}, ...}` and
sensible OpenAPI docs at `http://localhost/backend/docs` (dev only).

## 5. Show it in the dashboard

The dashboard is config-driven: charts are declared in
`dashboard-frontend/src/config/plots.js` and rendered by reusable components
in `src/components/plots/`. Add an entry to the fitting section array:

```js
// config/plots.js  (inside e.g. TRIP_PLOTS)
{
  id: 'trip-duration',
  component: ComparisonBarPlot,          // pick/reuse an existing component
  title: 'Average Trip Duration',
  props: {
    title: 'Average Trip Duration',
    backendUrlTemplate: '/backend/data/{datasetId}/trip_duration.json',
    exportFilename: 'avg-trip-duration',
  },
},
```

`{datasetId}` is substituted per comparison slot, so the chart automatically
works in dataset-comparison mode. If no existing plot component fits, copy the
closest one in `src/components/plots/` — they all follow the same pattern:
fetch via the URL template (react-query, keyed by `datasetId`), map the
`{label: {Source: …}}` response to Plotly traces.

Open `http://localhost/dashboard/` — the chart is live (HMR).

## 6. Variant: a map feature instead

For the webmap the backend side is identical (steps 2–4). On the frontend:

* data hooks live in `webmap-frontend/src/components/map/use*.js` — copy the
  closest one (e.g. `useNodeFlowLayers.js` for click-driven fetches,
  `useLinkSpeedsLayers.js` for canton-wide layers),
* fetch `/backend/data/${datasetId}/your_route.json?…` with an
  `AbortController` (cancel superseded requests) and a module-level cache
  keyed by `${datasetId}:${param}`,
* add sources/layers via `map.addSource`/`map.addLayer`, clean up in the
  effect teardown, and mind `minzoom` so features appear at the zoom level
  users actually reach.

## 7. Ship it

```bash
git add webmap-backend/providers/trip_duration.py \
        webmap-backend/providers/__init__.py \
        dashboard-frontend/src/config/plots.js
git commit -m "trip duration chart"
git push origin main            # CI rebuilds the touched images (GHCR)
```

On a dev-mode server: `git pull` + `docker compose … restart webmap_backend`
(backend) — frontend picks the change up via vite. On a prod server:
`docker compose pull && docker compose up -d` once CI finishes.

---

**Need auth inside the route** (per-user behavior, admin-only)? See
[webmap-backend.md → Adding an authenticated route](webmap-backend.md#adding-an-authenticated-route).

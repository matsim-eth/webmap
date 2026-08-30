# Custom simulation runs (sim-backend + sim-worker)

"Remove this road segment and re-run the simulation" — as a service.
Users (or the AI agent on their behalf) describe a **scenario diff** on a
base dataset; a worker on the compute machine mutates the MATSim inputs,
runs eqasim, exports the webmap DuckDB and uploads the result as a new
private dataset of the submitting user.

```
Chat/App/MCP ─► agent tools: propose_simulation / confirm_simulation /
                simulation_status / cancel_simulation
                      │  (validated ScenarioDiff JSON — sim-backend/dsl.py)
                      ▼
   sim_backend (this service, /backend/sim/)
   • validates the diff (Pydantic = security boundary)
   • checks dataset access (dataset service /resolve) + per-user quota
   • lifecycle: proposed → queued → running → uploading → done/failed
   • worker API: claim / progress / complete / fail  (X-Worker-Token)
   • mints a short-lived USER token per job → results belong to the user
                      ▲  outbound HTTPS pull (no inbound port on compute)
                      │
   sim_worker (deploy/sim-worker.compose.yml, image: sim-worker/)
   1. copy scenario bundle → workdir
   2. apply diff (apply_diff.py: network/transit/vehicles/population XML)
   3. java RunSimulation (progress = MATSim iteration log)
   4. analysis.webmap_export.run_standalone → synthetic.duckdb
   5. build_transit_volumes retrofit (PT passenger volumes)
   6. upload via dataset API as the user (+ base microcensus.duckdb)
```

## Scenario DSL (dsl.py — the single source of truth)

Operations (all strictly validated, ids/filters resolved fail-fast in the
worker BEFORE compute is burned):

| op | what |
|---|---|
| `modify_links` | set/scale freespeed_kmh, capacity, lanes, modes — by ids or filter (road_type, modes, speed/capacity ranges, polygon) |
| `close_links` | make links unusable without deleting (safe road closure) |
| `remove_links` | physically delete; population routes scrubbed; refused if the transit schedule uses the link |
| `add_node` / `add_link` | extend the network (lon/lat → LV95, auto length, optional bidirectional) |
| `remove_transit_lines` | drop lines by ids or filter (mode, name) |
| `scale_transit_frequency` | ×2 = extra departures at midpoints (cloned vehicles), ×0.5 = thin out |
| `scale_transit_vehicle_capacity` | scaled copies of the vehicle types serving the lines |

Params: `iterations` (1–200), `random_seed`, `config_overrides`
(raw `--config:module.param` — admin only).

## Consent + safety model

* A **proposal never runs** — the UI shows summary + runtime estimate and
  the run starts only via `confirm` (the agent is prompt- AND test-gated
  to require an explicit user yes in a later message).
* Quota: `SIM_MAX_ACTIVE_PER_USER` (default 2) queued+running per user.
* Proposals expire after `SIM_PROPOSAL_TTL_MIN` (default 120).
* Cancel: proposed/queued die instantly; running jobs stop at the next
  worker heartbeat (java is terminated).

## Setting up a base scenario (admin, once per base dataset)

On the compute machine, create a bundle directory with the base run's
prepared inputs (from the eqasim pipeline's `matsim.simulation.prepare`
cache) + the jar + the base microcensus:

```
bundles/base1/
  switzerland_config.xml            switzerland_network.xml.gz
  switzerland_transit_schedule.xml.gz  switzerland_transit_vehicles.xml.gz
  switzerland_population.xml.gz     switzerland_households.xml.gz
  switzerland_vehicles.xml.gz       switzerland_facilities.xml.gz
  eqasim-switzerland-*.jar          microcensus.duckdb   (from the base run)
```

Register it (admin token):

```bash
curl -X POST https://SERVER/backend/sim/scenarios \
  -H "Content-Type: application/json" -b "access_token=..." \
  -d '{"dataset_id": 1, "bundle_path": "/bundles/base1",
       "jar_path": "/bundles/base1/eqasim-switzerland-1.0.jar",
       "java_memory": "192G", "threads": 48,
       "minutes_per_iteration": 6}'
```

## Deploying the worker

The compute machine needs neither a repo checkout nor a build — the image
comes from ghcr (CI: `.github/workflows/build-sim-worker.yml`), the compose
file straight from GitHub:

```bash
mkdir simworker && cd simworker && mkdir bundles
# private repo → add:  -H "Authorization: Bearer <github PAT>"
curl -fsSLO https://raw.githubusercontent.com/matsim-eth/webmap/main/deploy/sim-worker.compose.yml
cat > .env <<'EOF'
BROKER_URL=http://YOUR-SERVER/backend/sim
DATASET_API_URL=http://YOUR-SERVER/backend/datasets
SIM_WORKER_TOKEN=<same value as in the server .env>
WORKER_ID=worker-1
EOF
docker login ghcr.io          # once, if the packages are private
docker compose -f sim-worker.compose.yml --env-file .env pull
docker compose -f sim-worker.compose.yml --env-file .env up -d
```

Updates: `docker compose -f sim-worker.compose.yml pull && docker compose -f
sim-worker.compose.yml up -d`. A second machine = the same three files with its
own WORKER_ID. `DRY_RUN=1` runs the whole chain without java (used in
tests).

Upload credentials never expire mid-run: the worker fetches a FRESH user
token from the broker right before uploading (`/worker/jobs/{id}/token`);
the claim-time token (`SIM_UPLOAD_TOKEN_HOURS`, default 48 h) is only the
fallback if the broker is briefly unreachable at that moment.

## Tests

* `sim-worker/tests/test_apply_diff.py` — every operation against MATSim
  fixture XMLs (12 tests: selectors, transit-conflict guard, population
  scrub, departure math, vehicle-type scaling).
* `sim-backend/tests/test_broker.py` — DSL rejection suite + full job
  lifecycle, quota, cancel, auth gates (sqlite, no services needed).
* E2E (scratch): live broker + real worker in DRY_RUN + stub dataset API —
  diff verifiably applied, upload performed, job `done`.
* LLM gate test: the agent proposes without confirming and confirms only
  after an explicit user yes.

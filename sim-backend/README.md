# Custom simulation runs (sim-backend + sim-worker)

"Remove this road segment and re-run the simulation" — as a service.
Users (or the AI agent on their behalf) describe a **scenario diff** on a
base dataset; a worker on the compute machine mutates the MATSim inputs,
runs eqasim, and publishes the raw outputs through the platform's own
dataset ingest — the result is a new private dataset of the submitting
user, built by the same code as every other dataset.

```
Chat (/sim …) / App / MCP ─► agent tools: propose_simulation /
                             confirm_simulation / simulation_status /
                             cancel_simulation
                      │  (validated ScenarioDiff JSON — sim-backend/dsl.py)
                      ▼
   sim_backend (this service, /backend/sim/)
   • validates the diff (Pydantic = security boundary)
   • checks dataset access (dataset service /resolve) + per-user quota
   • lifecycle: proposed → queued → running → uploading → done/failed
   •            cancelled/failed ──resume──► new queued job
   • worker API: claim / progress / complete / fail  (X-Worker-Token)
   • mints a short-lived USER token per job → results belong to the user
                      ▲  outbound HTTPS pull (no inbound port on compute)
                      │
   sim_worker (deploy/sim-worker.compose.yml, image: sim-worker/)
   1. copy scenario bundle → workdir
   2. apply diff (apply_diff.py: network/transit/vehicles/population XML)
   3. java RunSimulation (progress = MATSim iteration log, plans
      checkpoint every PLANS_INTERVAL iterations)
   4. java RunTripAnalysis + RunActivityAnalysis → eqasim_trips/activities.csv
   5. dataset API as the user: create dataset, upload the base
      microcensus.duckdb, POST /datasets/{id}/ingest with the raw outputs
      (+ persons/households from the bundle), poll the build
```

## Asking for a run

In the webmap chat a run can only be **proposed when the message starts
with `/sim`** — runs are expensive, so proposing is a deliberate opt-in
(without the prefix the agent explains this instead of proposing). A
proposal never runs by itself: the chat shows title, a plain-language
description, the operation summary and a runtime estimate, and the run
starts only after an explicit yes / the ▶ button. Missing information
(which nodes a new link connects, one-way or bidirectional, …) is asked
for, never guessed.

Where it stands: sidebar → **Simulations** (status, phase, iteration
progress, log tail; Stop / Resume / Open result), the same rows under
**Dataset** (in-flight runs listed below the datasets, finished runs
tagged `sim`), and `simulation_status` in the chat.

## Scenario DSL (dsl.py — the single source of truth)

Operations (all strictly validated, ids/filters resolved fail-fast in the
worker BEFORE compute is burned):

| op | what |
|---|---|
| `modify_links` | set/scale freespeed_kmh, capacity, lanes, modes — by ids or filter (road_type, modes, speed/capacity ranges, polygon) |
| `close_links` | make links unusable without deleting (safe road closure) |
| `remove_links` | physically delete; population routes scrubbed; refused if the transit schedule uses the link |
| `add_node` / `add_link` | extend the network (lon/lat → LV95, auto length, `bidirectional` must be stated) |
| `remove_transit_lines` | drop lines by ids or filter (mode, name) |
| `scale_transit_frequency` | ×2 = extra departures at midpoints (cloned vehicles), ×0.5 = thin out |
| `scale_transit_vehicle_capacity` | scaled copies of the vehicle types serving the lines |

Every diff carries `title` + `description` (the agent writes the
description: what changes, what question the run answers — it becomes the
result dataset's description). Params: `iterations` (1–200),
`random_seed`, `config_overrides` (raw `--config:module.param` — admin
only).

## Consent, quota, stop + resume

* A **proposal never runs** — only `confirm` starts it (the agent is
  prompt- AND test-gated to require an explicit user yes in a later
  message; proposing itself needs the `/sim` prefix).
* Quota: `SIM_MAX_ACTIVE_PER_USER` (default 2) queued+running per user.
* Proposals expire after `SIM_PROPOSAL_TTL_MIN` (default 120).
* **Stop**: proposed/queued die instantly; running jobs stop at the next
  worker heartbeat (java is terminated). The worker keeps the job's
  directory (`WORKDIR_TTL_DAYS`, default 7).
* **Resume** (`POST /jobs/{id}/resume`, button in the UI): re-queues a
  cancelled/failed run as a new job. The worker that ran it is offered it
  first and continues from the last plans checkpoint
  (`controler.firstIteration` + `plans.inputPlansFile`), or skips straight
  to analysis/publish if MATSim had already finished; any other worker —
  or a pruned directory — restarts from scratch.

## Setting up a base scenario (admin, once per base dataset)

On the compute machine, create a bundle directory with the base run's
prepared inputs (from the eqasim pipeline's `matsim.simulation.prepare`
cache), the jar, and the base run's population attribute files that the
dataset ingest needs:

```
bundles/base1/
  switzerland_config.xml            switzerland_network.xml.gz
  switzerland_transit_schedule.xml.gz  switzerland_transit_vehicles.xml.gz
  switzerland_population.xml.gz     switzerland_households.xml.gz
  switzerland_vehicles.xml.gz       switzerland_facilities.xml.gz
  eqasim-switzerland-*.jar
  persons.parquet | persons.csv     (required — eqasim synthesis output)
  households.parquet | households.csv (optional: income/cars/ÖV charts)
  microcensus.duckdb                (from the base dataset)
```

Register it (admin token):

```bash
curl -X POST https://SERVER/backend/sim/scenarios \
  -H "Content-Type: application/json" -b "access_token=..." \
  -d '{"dataset_id": 1, "bundle_path": "/bundles/base1",
       "jar_path": "/bundles/base1/eqasim-switzerland-1.0.jar",
       "java_memory": "192G", "threads": 48,
       "minutes_per_iteration": 6, "sample_rate": 0.01}'
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
token from the broker right before publishing (`/worker/jobs/{id}/token`);
the claim-time token (`SIM_UPLOAD_TOKEN_HOURS`, default 48 h) is only the
fallback if the broker is briefly unreachable at that moment. The dataset
ingest endpoints accept the dataset's owner (the user), so no admin
credentials ever reach the compute machine.

## Tests

* `sim-worker/tests/test_apply_diff.py` — every operation against MATSim
  fixture XMLs (selectors, transit-conflict guard, population scrub,
  departure math, vehicle-type scaling).
* `sim-worker/tests/test_runner.py` — java/analysis command lines, resume
  checkpoint detection, bundle checks, workdir pruning.
* `sim-worker/tests/test_uploader.py` — publish flow against a mocked
  dataset API (name-conflict retry, multipart ingest, status polling,
  cleanup of a failed build).
* `sim-backend/tests/test_broker.py` — DSL rejection suite, full job
  lifecycle, quota, cancel, auth gates, description round-trip, resume +
  worker affinity (sqlite, no services needed).
* LLM gate test: the agent proposes only with `/sim`, asks for missing
  details, and confirms only after an explicit user yes.

First real java run on the compute machine is the remaining acceptance
test (MATSim config option names, eqasim analysis arguments) — errors
surface in the job's log tail in the Simulations panel.

"""Cache warming for the heavy per-dataset builds.

Two producers feed **one** background worker thread:

* :func:`start` — the startup prewarm. Queues every dataset on disk in
  :func:`prewarm_order` (admin default first, then ascending id), or the first
  ``WEBMAP_PREWARM_LIMIT`` of them when that is set.
* :func:`request_warm` — called from the request path (``providers/base.py``
  and ``main.py:matsim_asset``) the first time this worker process resolves a
  given dataset root. **This is what covers a dataset switch:** waiting for the
  startup pass to reach your dataset means the first heavy click runs its whole
  build inside your request. Any ``/data/{id}/…`` request for a dataset — the
  zone layer, the network geometry, anything the map loads on switch — marks it
  **urgent**, which both queues it if it wasn't and moves it to the front if it
  was.
* :func:`request_zone_warm` — the same idea one level down, for the assets that
  are per *zone* and so have nothing to warm until a zone is known. See
  :data:`ZONE_STEPS`.

One queue, one worker, so two datasets can never build at once. The worker
schedules **one step at a time** (not one dataset at a time): after each step it
re-checks the queue, and a speculative job steps aside for an urgent one instead
of holding the CPU for its remaining builds. That matters because the traffic
gate below only *defers* work — once a ~100 s build has started nothing can
preempt it — so between-step hand-off is the only place a dataset the user just
opened can overtake one nobody is looking at.

Step order within a dataset is deliberate and depends on which frontend asked —
see :data:`WARM_STEPS` and :data:`MAP_ORDER` / :data:`DASHBOARD_ORDER`.
"""

from __future__ import annotations

import logging
import os
import threading
import time

from .paths import set_root_override

logger = logging.getLogger(__name__)


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes"}


PREWARM_ENABLED = _env_flag("WEBMAP_PREWARM", True)
# Warm-on-switch is a separate feature from the startup prewarm, but defaults to
# following it: someone who set WEBMAP_PREWARM=0 wants no heavy background
# builds, and would not expect a dataset switch to start one.
WARM_ON_SWITCH = _env_flag("WEBMAP_WARM_ON_SWITCH", PREWARM_ENABLED)


# ─── Traffic gate ─────────────────────────────────────────────────────────
# Warming necessarily runs inside the *serving* process — its whole point is to
# fill in-process caches — so its long pure-Python stretches (parsing the ~76 MB
# boarding asset, walking ~116k stops) contend with the request threadpool for
# the GIL and the CPU. Measured: a cold `destination_zones.json` that costs
# 0.1 s warm took **88 s** when it landed inside a transit-stops build, and it
# completed 3 s after that build finished.
#
# So each unit of work waits for a gap in live traffic before starting. NOTE
# this *defers* work, it does not preempt it — a request arriving after a build
# has begun still contends with it.

_traffic_lock = threading.Lock()
_traffic_inflight = 0        # data requests currently being served
_traffic_last_end = 0.0      # time.monotonic() when the last one finished

# Seconds of no data traffic before a startup-prewarm unit may start.
QUIET_S = float(os.getenv("WEBMAP_PREWARM_QUIET", "3"))
# Shorter for a switch-triggered warm: that user is actively clicking through
# the new dataset, so traffic comes in bursts a few seconds apart and a 3 s
# threshold can keep deferring past the moment the data is actually wanted.
SWITCH_QUIET_S = float(os.getenv("WEBMAP_WARM_QUIET", "1"))
# Cap on deferring a single unit, so continuous traffic can't starve warming
# forever — past this we accept the contention and build anyway.
MAX_WAIT_S = float(os.getenv("WEBMAP_PREWARM_MAX_WAIT", "300"))
# Breather after each unit, so anything queued behind it is served before the
# next unit grabs the CPU.
YIELD_S = float(os.getenv("WEBMAP_PREWARM_YIELD", "1"))


def traffic_begin() -> None:
    global _traffic_inflight
    with _traffic_lock:
        _traffic_inflight += 1


def traffic_end() -> None:
    global _traffic_inflight, _traffic_last_end
    with _traffic_lock:
        _traffic_inflight -= 1
        _traffic_last_end = time.monotonic()


def await_quiet(label: str, quiet: float = QUIET_S) -> None:
    """Block the calling (warm) thread until no data request has been in flight
    for *quiet* seconds, or `MAX_WAIT_S` elapses."""
    if quiet <= 0:
        return
    deadline = time.monotonic() + MAX_WAIT_S
    deferred = False
    while time.monotonic() < deadline:
        with _traffic_lock:
            idle_for = 0.0 if _traffic_inflight else time.monotonic() - _traffic_last_end
        if idle_for >= quiet:
            if deferred:
                logger.info("warm resuming (%s): traffic idle", label)
            return
        if not deferred:
            logger.info("warm deferring %s: serving requests", label)
            deferred = True
        time.sleep(0.25)
    logger.info("warm starting %s anyway after %.0fs of traffic", label, MAX_WAIT_S)


# ─── The steps ────────────────────────────────────────────────────────────

def _step_zones() -> None:
    from .study_area import study_area_dict, zones_fc_bytes

    study_area_dict()
    zones_fc_bytes(False)


def _step_transit_stops() -> None:
    # Only `inter_cantonal_stops()` still needs warming. The per-zone path
    # (`stops_by_canton`) resolves coordinates for one zone at a time and costs
    # ~1.3 s cold, so it serves itself; this step exists for the whole-dataset
    # coord scan behind the inter-cantonal bundle, which a line click wants.
    from .transit_stops import inter_cantonal_stops

    inter_cantonal_stops()


def _step_destination_zones() -> None:
    from .destination_zones import warm

    warm()


def _step_dashboard_assets() -> None:
    """The two dashboard-only static assets that nothing else warms.

    Both parse a static_assets BLOB into a per-dataset cache and are otherwise
    paid for by whoever opens the Transit Stops / Transit Lines tabs first.
    `helpers.load_static_asset` has no cache of its own, so an unwarmed one is a
    full blob read + JSON parse inside the request."""
    from .stop_municipality import StopMunicipalityProvider
    from .stop_transfer_data import StopTransferDataProvider

    for provider in (StopTransferDataProvider, StopMunicipalityProvider):
        try:
            provider()._load()
        except Exception as exc:
            # One missing asset shouldn't skip the other.
            logger.debug("%s warm skipped: %s", provider.__name__, exc)


def _step_speed_dashboard() -> None:
    # NB: must match the params the frontends actually send — the cache keys on
    # (route, dataset, sorted params), so warming {} would leave the real
    # ?modes=car request to pay the full cold scan anyway.
    from .link_speeds import SpeedDashboardProvider

    SpeedDashboardProvider().deliver({"modes": "car"})


WARM_STEPS: dict[str, object] = {
    "zones/study_area": _step_zones,
    "transit stops": _step_transit_stops,
    "destination zones": _step_destination_zones,
    "speed_dashboard": _step_speed_dashboard,
    "dashboard assets": _step_dashboard_assets,
}


# ─── Zone-scoped steps ────────────────────────────────────────────────────
# The two heaviest per-zone assets. Unlike everything in WARM_STEPS these can't
# be warmed per *dataset*, because there is nothing to warm until a zone is
# known: the webmap opens with no zone selected (`clickedCanton` is null), and a
# dataset can have 26 cantons or 160 gemeinden, so warming them all would cost
# minutes and pin gigabytes. Instead :func:`request_zone_warm` queues these the
# moment a request reveals which zone the user is actually in — see the call
# sites in ``main.py:matsim_asset``.
#
# Measured on dataset 7036833688 (Swiss-wide), cold → warm:
#   {canton}_link_traffic_volumes.json?major=1   Aargau 3.2 s → 0.15 s
#   pt_link_volumes_by_link_line_{canton}.json   Zurich 10.3 s → 0.82 s
#                                                Bern    7.8 s
# Both were previously warmed by nothing at all, so every first visit to the
# Road Volumes / Transit Volumes module in a zone paid the full build inline.

def _step_zone_link_volumes(zone_id: int) -> None:
    """Per-link hourly car volumes for one zone — the road Volumes module.

    Only the ``major=True`` variant, which is what the module requests by
    default (`useNetworkLayers`: `?major=1` unless "major roads only" is
    unticked). The unfiltered variant is ~4× the payload and ~3× the build, and
    is reached only by unticking the box or opening a segment histogram — a
    deliberate second action, not the first paint. Warming both would double the
    memory this pins for a case the LRU already covers on the way back."""
    from .link_speeds import link_traffic_volumes

    link_traffic_volumes(zone_id, None, True)


def _step_zone_pt_volumes(zone_id: int) -> None:
    """Per-link/line/15-min PT volumes for one zone — the Transit Volumes module.

    Returns None (not raises) on a dataset with no `pt_link_volumes` table, so
    older datasets just warm nothing here."""
    from .pt_link_volumes import volumes_by_link_line

    volumes_by_link_line(zone_id)


ZONE_STEPS: dict[str, object] = {
    "link volumes": _step_zone_link_volumes,
    "pt link volumes": _step_zone_pt_volumes,
}

# Cheapest and most-used first: the road Volumes module is the commoner
# destination and builds in ~2-3 s, against ~8-10 s for the PT payload.
ZONE_ORDER = ["link volumes", "pt link volumes"]

# Every profile runs every step — only the order differs, because a warm that is
# still running when the user clicks is worth exactly as much as what it has
# finished. So whichever frontend asked gets its own blocking builds first.
#
#   zones/study_area  — cheap, but on the critical path of the very first render
#                       (simplify + reproject + per-zone bbox scan). Both.
#   destination zones — pages in the `trips` columns. Webmap only.
#   dashboard assets  — stop_transfer_data + stop_municipality blob parses.
#                       Dashboard's Transit tabs only; seconds, not tens of them,
#                       so it goes ahead of the speed scan (shortest first).
#   speed_dashboard   — a ~50M-row link_speeds scan. Dashboard's Speed tab only,
#                       so nothing on the map waits on it.
#   transit stops     — the whole-dataset coord scan behind inter_cantonal_stops
#                       (~12 s on a gemeinde-zoned dataset, ~70-100 s Swiss-wide):
#                       still the single longest step, and now **last in both
#                       orders**. It used to run second on the map because the
#                       whole per-dataset stops build sat in front of the first
#                       Transit Stops click; since that build was split, opening
#                       a zone resolves only that zone's coordinates (~1.3 s
#                       cold) and no longer touches this. What is left needs a
#                       *line* click, which is several interactions in, so
#                       spending the first minute of every dataset's warm on it
#                       just delayed the steps something actually waits on.
#
# The per-line transit_routes index is deliberately in none of them: it parses
# the ~76 MB routes asset and would hold that in RAM for every warmed dataset. It
# builds lazily on the first line selection (transit_routes.ensure_warm(), which
# the stops request kicks off in the background *after* answering).
MAP_ORDER = [
    "zones/study_area", "destination zones", "dashboard assets",
    "speed_dashboard", "transit stops",
]
DASHBOARD_ORDER = [
    "zones/study_area", "dashboard assets", "speed_dashboard",
    "destination zones", "transit stops",
]

# Default (unknown caller, and the startup prewarm) = map order: the webmap is
# the client whose modules block hardest on these builds, and its spatial builds
# also cover the dashboard's Transit Stops tab.
_ORDERS = {"webmap": MAP_ORDER, "dashboard": DASHBOARD_ORDER}


def profile_from_referer(referer: str | None) -> str | None:
    """Which frontend a request came from: ``"webmap"``, ``"dashboard"``, or
    None when it can't be told.

    Read from the ``Referer`` header — both frontends are served from the same
    origin as the API (nginx routes ``/webmap/``, ``/dashboard/`` and
    ``/backend/``), so the browser's default referrer policy sends the full
    path and no frontend change is needed. A missing/odd header just falls back
    to the default order rather than failing."""
    if not referer:
        return None
    for name in ("webmap", "dashboard"):
        if f"/{name}/" in referer or referer.rstrip("/").endswith(f"/{name}"):
            return name
    return None


def _run_step(root: str, label: str, quiet: float, zone: int | None = None) -> None:
    """Run one warm step for one dataset, behind the traffic gate. *zone* selects
    a :data:`ZONE_STEPS` entry instead of a :data:`WARM_STEPS` one.

    Errors are swallowed — an incompatible dataset just skips that step and the
    job carries on with the rest.

    The traffic gate is also what keeps a zone warm from duplicating work the
    request that triggered it is already doing: entering the Volumes module
    fetches the geometry and the volumes at once, so the volumes request is
    in flight when the warm is queued, the gate defers past it, and the step
    then finds its own cache already filled and returns immediately."""
    name = os.path.basename(root)
    tag = name if zone is None else f"{name} zone {zone}"
    await_quiet(f"{label} [{tag}]", quiet)
    set_root_override(root)
    t0 = time.monotonic()
    try:
        ZONE_STEPS[label](zone) if zone is not None else WARM_STEPS[label]()
    except Exception as exc:
        logger.warning("%s warm skipped for %s: %s", label, tag, exc)
    else:
        logger.info("warmed %s for %s in %.1fs", label, tag, time.monotonic() - t0)
    finally:
        set_root_override(None)
    if YIELD_S > 0:
        time.sleep(YIELD_S)


# ─── Queue + worker ───────────────────────────────────────────────────────

def _job_key(root: str, zone: int | None) -> str:
    """Identity of a job in the queue. A dataset job and each of its zone jobs
    are separate units of work, so they must not dedupe against each other."""
    return root if zone is None else f"{root}#zone:{zone}"


class _Job:
    """One dataset's remaining warm steps, or one *zone*'s when `zone` is set.

    `urgent` marks a dataset somebody actually has open (see `request_warm`) as
    opposed to one the startup pass queued speculatively; it is what lets the
    worker hand the CPU over between steps. Zone jobs are always urgent — they
    exist only because a request just named that zone."""

    __slots__ = ("root", "zone", "quiet", "profile", "urgent", "steps")

    def __init__(self, root: str, quiet: float, profile: str | None, urgent: bool,
                 zone: int | None = None):
        self.root = root
        self.zone = zone
        self.quiet = quiet
        self.profile = profile
        self.urgent = urgent
        self.steps = (
            list(ZONE_ORDER) if zone is not None
            else list(_ORDERS.get(profile or "", MAP_ORDER))
        )

    @property
    def key(self) -> str:
        return _job_key(self.root, self.zone)

    def reprofile(self, profile: str | None, quiet: float, urgent: bool) -> None:
        """Re-order the steps this job has **left** for a new caller, keeping
        whatever it already built. Called when the client that asked changes —
        a dataset queued by the dashboard that the webmap then opens should
        finish map-first.

        A zone job has one fixed order and only two steps, so there is nothing
        to re-order; it just takes the shorter quiet window."""
        if self.zone is None:
            remaining = set(self.steps)
            self.steps = [l for l in _ORDERS.get(profile or "", MAP_ORDER) if l in remaining]
            self.profile = profile or self.profile
        self.quiet = quiet
        self.urgent = self.urgent or urgent


_q_cv = threading.Condition()
_pending: list[_Job] = []          # front = next up
_current: _Job | None = None       # the job whose step is running right now
_seen: set[str] = set()            # job keys queued, running or already warmed
_worker: threading.Thread | None = None


def _rank(job: "_Job") -> int:
    """Scheduling tier, lowest first. Three tiers, in order of how sure we are
    the work is about to be wanted:

    0. **zone job** — a request just named this zone; the user is one module
       switch from needing it, and it costs seconds, not a minute.
    1. **urgent dataset job** — somebody has this dataset open (`request_warm`).
    2. **speculative dataset job** — queued by the startup prewarm; nobody has
       asked for it.
    """
    if job.zone is not None:
        return 0
    return 1 if job.urgent else 2


def _insert(job: "_Job") -> None:
    """Put *job* at the front of its own tier (caller holds `_q_cv`).

    Ahead of everything of lower priority, behind everything of equal or higher
    — so a job resuming between steps gets the CPU straight back unless a more
    targeted one arrived meanwhile. This generalises the two hardcoded cases it
    replaced: an urgent job used to re-insert at 0 unconditionally (which let it
    jump a zone job that a live request had just queued), and a speculative one
    stepped aside past the urgent jobs, which is what tier 2 does here."""
    r = _rank(job)
    idx = next((i for i, j in enumerate(_pending) if _rank(j) >= r), len(_pending))
    _pending.insert(idx, job)


def _run() -> None:
    global _current
    while True:
        with _q_cv:
            while not _pending:
                _q_cv.wait()
            job = _pending.pop(0)
            _current = job
            label = job.steps.pop(0)
            quiet, root, zone = job.quiet, job.root, job.zone

        _run_step(root, label, quiet, zone)

        with _q_cv:
            _current = None
            if not job.steps:
                continue
            if _pending and _rank(_pending[0]) < _rank(job):
                logger.info("warm yielding %s to higher-priority work",
                            os.path.basename(job.root))
            _insert(job)
            _q_cv.notify()


def _ensure_worker() -> None:
    """Start the single warm thread on first use (caller holds `_q_cv`)."""
    global _worker
    if _worker is None:
        _worker = threading.Thread(target=_run, name="warmup", daemon=True)
        _worker.start()


def _enqueue(root: str, quiet: float, profile: str | None, urgent: bool,
             zone: int | None = None) -> bool:
    """Queue *root* (or one of its zones), or re-prioritise it if it is already
    queued/running. Returns whether a new job was created.

    Three cases beyond "new job": the unit is **running** (upgrade it in place
    so its remaining steps follow this caller and it stops being preemptable),
    **pending** (same, plus re-file it at its tier's front), or **done**
    (`_seen` without a job — nothing to do)."""
    key = _job_key(root, zone)
    with _q_cv:
        if _current is not None and _current.key == key:
            if urgent and not (_current.urgent and _current.profile == profile):
                _current.reprofile(profile, quiet, urgent)
            return False
        for i, job in enumerate(_pending):
            if job.key == key:
                if urgent:
                    job.reprofile(profile, quiet, urgent)
                    _insert(_pending.pop(i))
                    _q_cv.notify()
                return False
        if key in _seen:
            return False
        _seen.add(key)
        job = _Job(root, quiet, profile, urgent, zone)
        _insert(job) if _rank(job) < 2 else _pending.append(job)
        _ensure_worker()
        _q_cv.notify()
    return True


def request_warm(root: str, profile: str | None = None) -> None:
    """Mark *root* as a dataset someone has open: warm it next, in *profile*'s
    step order (``"webmap"``/``"dashboard"``, see :func:`profile_from_referer`).

    Called from the request path on every ``/data/{id}/…`` request, so it must
    stay trivially cheap in the already-warmed case (one identity check plus a
    short scan under a lock). Never raises and never blocks the request."""
    if not WARM_ON_SWITCH or not root:
        return
    try:
        if _enqueue(root, SWITCH_QUIET_S, profile, urgent=True):
            logger.info("warm requested for %s by %s (first request in this worker)",
                        os.path.basename(root), profile or "unknown client")
    except Exception as exc:      # warming is best-effort; never break a request
        logger.debug("warm request failed for %s: %s", root, exc)


def request_zone_warm(root: str, zone_id: int | None) -> None:
    """Mark *zone_id* of *root* as the zone someone is looking at: build its
    Road Volumes and Transit Volumes payloads (see :data:`ZONE_STEPS`) in the
    background so the first switch into either module doesn't pay for them.

    Called from ``main.py:matsim_asset`` on the assets that identify a zone the
    user just opened — the network geometry and the transit stops — rather than
    on the volume assets themselves, since by then the wait has already started.

    Queued **urgent** (front of the queue, short quiet window): unlike the
    startup prewarm this is not speculative, somebody is one click away from
    wanting it. Each zone is queued at most once per worker; if its LRU entry is
    later evicted, the re-fetch pays the build again rather than re-warming.

    Never raises and never blocks the request."""
    if not WARM_ON_SWITCH or not root or zone_id is None:
        return
    try:
        if _enqueue(root, SWITCH_QUIET_S, None, urgent=True, zone=zone_id):
            logger.info("zone warm requested for %s zone %s",
                        os.path.basename(root), zone_id)
    except Exception as exc:      # warming is best-effort; never break a request
        logger.debug("zone warm request failed for %s zone %s: %s", root, zone_id, exc)


# ─── Startup prewarm ──────────────────────────────────────────────────────

def _dataset_service_order() -> list[str]:
    """Dataset ids from the dataset service, default-first then ascending id.

    Empty list on any failure (service not up yet, no internal secret configured,
    timeout) — the caller then falls back to the filesystem id sort, which agrees
    with this apart from not knowing which dataset the admin marked default.
    """
    import httpx

    # Send the secret when configured. When it is unset the dataset service
    # skips the check entirely (relying on network isolation), so still make the
    # call — bailing out here would disable default-first prewarming on every
    # deployment that hasn't set the secret, which includes the dev stack.
    secret = os.getenv("INTERNAL_SERVICE_SECRET", "").strip()
    headers = {"X-Internal-Secret": secret} if secret else {}
    url = os.getenv("DATASET_SERVICE_URL", "http://dataset_backend:5033")
    try:
        resp = httpx.get(f"{url}/internal/datasets/order", headers=headers, timeout=5.0)
        if resp.status_code != 200:
            return []
        return [str(i) for i in resp.json().get("dataset_ids", [])]
    except Exception as exc:
        logger.info("dataset order lookup failed, using id order: %s", exc)
        return []


def prewarm_order(db_paths: list[str]) -> list[str]:
    """Dataset roots in the order the prewarm should walk them: the admin-chosen
    **default dataset first**, then ascending dataset id.

    Ordering matters because a dataset's steps run to tens of seconds, so
    whichever dataset is warmed last spends minutes cold — and if that is the
    one the frontends open by default, the first user to touch it runs those
    builds inside their request, contending with the warm thread. (The
    `sorted()` this replaced ordered *paths as strings*,
    so `1`, `2`, `3` preceded `7318579365` purely by string length, and under the
    old `created_at DESC` list order the default landed last.)

    The default comes from the dataset service (`/internal/datasets/order`); when
    that is unreachable — it may not be up yet at startup — this degrades to
    ascending id, which is the same order minus the default's promotion. A
    dataset directory's name *is* its id, so that fallback needs no DB access.

    `WEBMAP_PREWARM_ORDER` (comma-separated ids) overrides both, pinning datasets
    to the front; unlisted ones follow, and unknown ids are ignored.
    """
    roots = {os.path.dirname(p) for p in db_paths}

    def id_key(root: str) -> tuple:
        """(0, id) for numeric dir names, (1, name) for anything else — so a
        non-dataset directory sorts last instead of raising on int()."""
        name = os.path.basename(root)
        return (0, int(name), "") if name.isdigit() else (1, 0, name)

    ordered = sorted(roots, key=id_key)

    # Promote in the dataset service's order (default first). Only reorders what
    # is already on disk; ids with no directory are ignored, and directories the
    # service doesn't know about keep their id-sorted place at the back.
    service_ids = _dataset_service_order()
    if service_ids:
        by_name = {os.path.basename(r): r for r in ordered}
        front = [by_name[i] for i in service_ids if i in by_name]
        ordered = front + [r for r in ordered if r not in set(front)]

    pinned = [p.strip() for p in os.getenv("WEBMAP_PREWARM_ORDER", "").split(",") if p.strip()]
    if pinned:
        by_name = {os.path.basename(r): r for r in ordered}
        front = [by_name[n] for n in pinned if n in by_name]
        ordered = front + [r for r in ordered if r not in set(front)]
    return ordered


def _prewarm() -> None:
    """Queue the startup datasets (see `WARM_STEPS` for what each warm does).

    **All** of them by default, in `prewarm_order` — default dataset first, then
    ascending id — so a dataset is warm even the first time anyone opens it, and
    every worker converges on fully warm. `WEBMAP_PREWARM_LIMIT` caps it (0/unset
    = all, 1 = just the default).

    What makes warming everything affordable is that it is not the *only*
    mechanism any more: it is speculative work, it runs behind the traffic gate,
    and `request_warm` both promotes the dataset a user actually opens to the
    front and lets the worker preempt a speculative job between steps. The cost
    it can't dodge is memory — each warmed dataset pins its stops bundle and
    dashboard aggregate for the life of the worker, times `UVICORN_WORKERS`. Set
    WEBMAP_PREWARM_LIMIT=1 on a small box."""
    import glob

    # Debounce for dev: uvicorn --reload restarts the process on every file
    # save, and each restart would immediately kick off full table scans of
    # every dataset — misery on a laptop. Waiting a bit first means rapid
    # edit-reload cycles kill the (daemon) thread before it does heavy work;
    # the cache still warms once the code settles. Prod (ENV != dev) starts
    # immediately. Override with WEBMAP_PREWARM_DELAY (seconds).
    delay = os.getenv("WEBMAP_PREWARM_DELAY", "").strip()
    delay_s = float(delay) if delay else (15.0 if os.getenv("ENV", "dev") == "dev" else 0.0)
    if delay_s > 0:
        time.sleep(delay_s)

    base = os.getenv("WEBMAP_ROOT", "/data/datasets/public")
    roots = prewarm_order(glob.glob(os.path.join(base, "*", "synthetic.duckdb")))

    # Cap on how many datasets to warm. Unset/0/negative means all; a
    # non-numeric value falls back to all rather than crashing the thread.
    try:
        limit = int(os.getenv("WEBMAP_PREWARM_LIMIT", "0").strip() or 0)
    except ValueError:
        limit = 0
    skipped = roots[limit:] if limit > 0 else []
    if limit > 0:
        roots = roots[:limit]

    logger.info(
        "prewarm order: %s%s",
        ", ".join(os.path.basename(r) for r in roots) or "(none)",
        f" (skipping {len(skipped)}: warmed on demand when opened)" if skipped else "",
    )
    for root in roots:
        _enqueue(root, QUIET_S, None, urgent=False)


def start() -> None:
    """Kick off the startup prewarm (in its own thread, since it sleeps and may
    call the dataset service before it can queue anything)."""
    if not PREWARM_ENABLED:
        return
    threading.Thread(target=_prewarm, name="prewarm", daemon=True).start()

"""Sim worker daemon — pulls jobs from the broker and runs them.

    claim → prepare (copy bundle + apply diff) → simulate (java)
          → analyse (eqasim trip/activity CSVs) → publish (dataset API:
            create + ingest raw outputs, poll the build) → done

Pull model: only outbound HTTPS to the broker/dataset API — nothing
listens on the compute machine. Heartbeats carry phase/progress/log tail
and pick up cancellation requests.

Resume: a cancelled/failed job keeps its workdir. When the broker re-queues
it (resume_of) and this worker still holds that directory, the run
continues from the last plans checkpoint (PLANS_INTERVAL iterations) —
or skips straight to analysis if MATSim had already finished.

Env:
  BROKER_URL          e.g. https://server/backend/sim   (required)
  SIM_WORKER_TOKEN    shared secret                     (required)
  DATASET_API_URL     e.g. https://server/backend/datasets (required)
  WORKER_ID           display name (default: hostname)
  WORK_ROOT           scratch dir for job workdirs (default /work)
  WORKDIR_TTL_DAYS    keep interrupted workdirs this long (default 7)
  POLL_SECONDS        idle poll interval (default 10)
  DRY_RUN=1           skip java, fabricate tiny outputs (CI/E2E)
"""

from __future__ import annotations

import gzip
import os
import shutil
import socket
import threading
import time
import traceback
from pathlib import Path

import httpx

from apply_diff import DiffError, apply_diff
from runner import (OUTPUT_FILES, Cancelled, ProcessRunner, analysis_commands,
                    bundle_person_files, diff_applied, java_command,
                    mark_diff_applied, prepare_workdir, prune_workdirs,
                    run_state)
from uploader import DatasetApi, publish_result

BROKER_URL = os.getenv("BROKER_URL", "").rstrip("/")
WORKER_TOKEN = os.getenv("SIM_WORKER_TOKEN", "")
DATASET_API = os.getenv("DATASET_API_URL", "").rstrip("/")
WORKER_ID = os.getenv("WORKER_ID", socket.gethostname())
WORK_ROOT = Path(os.getenv("WORK_ROOT", "/work"))
WORKDIR_TTL_DAYS = float(os.getenv("WORKDIR_TTL_DAYS", "7"))
POLL_SECONDS = float(os.getenv("POLL_SECONDS", "10"))
HEARTBEAT_SECONDS = 15.0
DRY_RUN = os.getenv("DRY_RUN", "0") == "1"

_HEADERS = {"X-Worker-Token": WORKER_TOKEN, "X-Worker-Id": WORKER_ID}


def _api(method: str, path: str, **kw):
    with httpx.Client(timeout=30.0) as c:
        r = c.request(method, f"{BROKER_URL}{path}", headers=_HEADERS, **kw)
        r.raise_for_status()
        return r.json()


class Heartbeat(threading.Thread):
    """Periodic progress reports; sets .cancelled when the broker asks."""

    def __init__(self, job_id: int, runner: ProcessRunner) -> None:
        super().__init__(daemon=True)
        self.job_id = job_id
        self.runner = runner
        self.phase = "starting"
        self.progress = 0.0
        self.message = ""
        self.cancelled = threading.Event()
        self._stop = threading.Event()

    def set(self, phase=None, progress=None, message=None) -> None:
        if phase is not None:
            self.phase = phase
        if progress is not None:
            self.progress = min(1.0, max(0.0, progress))
        if message is not None:
            self.message = message

    def stop(self) -> None:
        self._stop.set()

    def flush(self) -> None:
        """One immediate report — used right before a fail/complete so the
        job shows the phase it ended in, not the last 15-s tick."""
        try:
            self._post()
        except Exception:
            pass

    def _post(self) -> None:
        resp = _api("POST", f"/worker/jobs/{self.job_id}/progress",
                    json={"phase": self.phase,
                          "progress": self.progress,
                          "message": self.message,
                          "log_tail": self.runner.log_tail})
        if resp.get("cancel_requested"):
            self.cancelled.set()
            self.runner.cancel()

    def run(self) -> None:
        while not self._stop.wait(HEARTBEAT_SECONDS):
            try:
                self._post()
            except Exception as exc:                   # broker hiccup — retry
                print(f"heartbeat failed: {exc}")


def _dry_run_outputs(output_dir: Path, staging: Path) -> None:
    """Fabricate minimal run outputs so the whole chain (analysis skipped,
    publish + ingest polling) is testable without java."""
    output_dir.mkdir(parents=True, exist_ok=True)
    staging.mkdir(parents=True, exist_ok=True)
    for name in OUTPUT_FILES.values():
        with gzip.open(output_dir / name, "wb") as f:
            f.write(b"<dry-run/>")
    (staging / "eqasim_trips.csv").write_text(
        "person_id;person_trip_id;origin_x;origin_y;destination_x;"
        "destination_y;departure_time;travel_time;routed_distance;"
        "euclidean_distance;mode;preceding_purpose;following_purpose\n")
    (staging / "eqasim_activities.csv").write_text(
        "person_id;activity_index;purpose;start_time;end_time;x;y\n")


def _adopt_workdir(resume_of: int | None, workdir: Path) -> bool:
    """Take over the interrupted job's directory for a resumed job."""
    if not resume_of:
        return False
    old = WORK_ROOT / f"job_{resume_of}"
    # Only a directory whose scenario diff was applied is worth continuing;
    # anything earlier is cheaper (and safer) to rebuild from the bundle.
    if not old.is_dir() or not diff_applied(old):
        return False
    if workdir.exists():
        shutil.rmtree(workdir)
    old.rename(workdir)
    return True


def process_job(job: dict) -> None:
    job_id = job["job_id"]
    iterations = int(((job.get("diff") or {}).get("params") or {})
                     .get("iterations") or 40)
    workdir = WORK_ROOT / f"job_{job_id}"
    output_dir = workdir / "simulation_output"
    staging = workdir / "staging"
    success = False

    runner = ProcessRunner(
        on_iteration=lambda i: hb.set(
            phase="simulating",
            progress=0.05 + 0.75 * (i / max(1, iterations)),
            message=f"iteration {i}/{iterations}"))
    hb = Heartbeat(job_id, runner)
    hb.start()

    def cancelled() -> bool:
        return hb.cancelled.is_set()

    try:
        # Fail fast on an unusable bundle - before any compute is burned.
        person_files = bundle_person_files(job["bundle_path"])

        adopted = _adopt_workdir(job.get("resume_of"), workdir)
        if adopted:
            runner.tail.append(f"resuming job {job['resume_of']} from its workdir")
            state, n = run_state(output_dir, iterations)
        else:
            hb.set(phase="preparing", progress=0.01, message="copying bundle")
            prepare_workdir(job["bundle_path"], workdir)
            hb.set(message="applying scenario diff")
            report = apply_diff(workdir, job["diff"],
                                log=lambda m: runner.tail.append(str(m)))
            mark_diff_applied(workdir, report)
            runner.tail.append(f"diff applied: {report}")
            state, n = "fresh", 0
        if cancelled():
            raise Cancelled("cancelled")

        if DRY_RUN:
            hb.set(phase="simulating", progress=0.5, message="DRY RUN")
            _dry_run_outputs(output_dir, staging)
        elif state == "done":
            runner.tail.append("simulation output already complete - skipping MATSim")
        else:
            first = n + 1 if state == "resume" else None
            hb.set(phase="simulating", progress=0.05 + 0.75 * (n / iterations),
                   message=(f"resuming MATSim at iteration {first}/{iterations}"
                            if first else f"starting MATSim ({iterations} iterations)"))
            runner.run(java_command(job, workdir, output_dir, first), workdir,
                       "simulation")

        if not DRY_RUN:
            hb.set(phase="analysing", progress=0.82,
                   message="eqasim trip + activity analysis")
            staging.mkdir(exist_ok=True)
            for what, cmd in analysis_commands(job, output_dir, staging):
                runner.run(cmd, workdir, what)

        files = {
            "trips": staging / "eqasim_trips.csv",
            "activities": staging / "eqasim_activities.csv",
            "network": output_dir / OUTPUT_FILES["network"],
            "events": output_dir / OUTPUT_FILES["events"],
            "transit_schedule": output_dir / OUTPUT_FILES["transit_schedule"],
            **person_files,
        }
        plans = output_dir / OUTPUT_FILES["plans"]
        if plans.exists():
            files["plans"] = plans
        missing = [k for k, p in files.items() if not p.is_file()]
        if missing:
            raise RuntimeError(f"run produced no {', '.join(missing)}")

        hb.set(phase="uploading", progress=0.86, message="uploading raw outputs")
        # Fresh user token just-in-time: a run may take days, the claim-time
        # token is only the fallback if the broker is briefly unreachable.
        try:
            upload_token = _api("POST", f"/worker/jobs/{job_id}/token")["user_token"]
        except Exception as exc:
            runner.tail.append(f"fresh-token fetch failed ({exc}) - "
                               "falling back to claim-time token")
            upload_token = job["user_token"]

        api = DatasetApi(DATASET_API, upload_token)
        try:
            micro = Path(job["bundle_path"]) / "microcensus.duckdb"
            ds_id = publish_result(
                api, job["title"], job.get("description") or "",
                {"base_dataset_id": job["base_dataset_id"],
                 "summary": job.get("summary") or [],
                 "params": (job.get("diff") or {}).get("params") or {}},
                files, micro if micro.exists() else None,
                run_name=f"sim job {job_id}", sample_rate=job.get("sample_rate"),
                log=lambda m: runner.tail.append(str(m)),
                on_ingest_progress=lambda p, step: hb.set(
                    phase="ingesting", progress=0.88 + 0.12 * p,
                    message=f"building dataset: {step}"),
                is_cancelled=cancelled)
        finally:
            api.close()
        if cancelled():
            raise Cancelled("cancelled")

        hb.flush()
        _api("POST", f"/worker/jobs/{job_id}/complete",
             json={"result_dataset_id": ds_id})
        success = True
        print(f"job {job_id} done -> dataset {ds_id}")
    except Cancelled:
        hb.flush()
        _api("POST", f"/worker/jobs/{job_id}/fail",
             json={"error": "cancelled by user", "cancelled": True})
        print(f"job {job_id} cancelled (workdir kept for resume)")
    except DiffError as exc:
        hb.flush()
        _api("POST", f"/worker/jobs/{job_id}/fail",
             json={"error": f"scenario error: {exc}"})
        print(f"job {job_id} diff error: {exc}")
    except Exception as exc:
        traceback.print_exc()
        hb.flush()
        _api("POST", f"/worker/jobs/{job_id}/fail",
             json={"error": f"{type(exc).__name__}: {exc}"[:3000]})
    finally:
        hb.stop()
        # Interrupted runs keep their directory so a resume can pick up the
        # checkpoint; prune_workdirs reclaims it after WORKDIR_TTL_DAYS.
        if success and os.getenv("KEEP_WORKDIR", "0") != "1":
            shutil.rmtree(workdir, ignore_errors=True)


def main() -> None:
    if not (BROKER_URL and WORKER_TOKEN and DATASET_API):
        raise SystemExit("BROKER_URL, SIM_WORKER_TOKEN and DATASET_API_URL "
                         "must be set")
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    print(f"sim-worker '{WORKER_ID}' polling {BROKER_URL} "
          f"(dry_run={DRY_RUN})")
    last_prune = 0.0
    while True:
        if time.time() - last_prune > 3600:
            for name in prune_workdirs(WORK_ROOT, WORKDIR_TTL_DAYS):
                print(f"pruned stale workdir {name}")
            last_prune = time.time()
        try:
            resp = _api("POST", "/worker/claim")
            job = resp.get("job")
        except Exception as exc:
            print(f"claim failed: {exc}")
            job = None
        if job:
            print(f"claimed job {job['job_id']}: {job['title']}")
            process_job(job)
        else:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()

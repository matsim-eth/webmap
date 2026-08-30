"""Sim worker daemon — pulls jobs from the broker and runs them.

    claim → prepare (copy bundle + apply diff) → simulate (java)
          → export (webmap duckdb) → retrofit (PT volumes) → upload → done

Pull model: only outbound HTTPS to the broker/dataset API — nothing
listens on the compute machine. Heartbeats carry phase/progress/log tail
and pick up cancellation requests.

Env:
  BROKER_URL          e.g. https://server/backend/sim   (required)
  SIM_WORKER_TOKEN    shared secret                     (required)
  DATASET_API_URL     e.g. https://server/backend/datasets (required)
  WORKER_ID           display name (default: hostname)
  WORK_ROOT           scratch dir for job workdirs (default /work)
  POLL_SECONDS        idle poll interval (default 10)
  DRY_RUN=1           skip java+export, fabricate a tiny result (CI/E2E)
"""

from __future__ import annotations

import os
import shutil
import socket
import threading
import time
import traceback
from pathlib import Path

import httpx

from apply_diff import DiffError, apply_diff
from runner import (Cancelled, ProcessRunner, export_command, java_command,
                    prepare_workdir, retrofit_transit_volumes)
from uploader import upload_result

BROKER_URL = os.getenv("BROKER_URL", "").rstrip("/")
WORKER_TOKEN = os.getenv("SIM_WORKER_TOKEN", "")
DATASET_API = os.getenv("DATASET_API_URL", "").rstrip("/")
WORKER_ID = os.getenv("WORKER_ID", socket.gethostname())
WORK_ROOT = Path(os.getenv("WORK_ROOT", "/work"))
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

    def run(self) -> None:
        while not self._stop.wait(HEARTBEAT_SECONDS):
            try:
                resp = _api("POST", f"/worker/jobs/{self.job_id}/progress",
                            json={"phase": self.phase,
                                  "progress": self.progress,
                                  "message": self.message,
                                  "log_tail": self.runner.log_tail})
                if resp.get("cancel_requested"):
                    self.cancelled.set()
                    self.runner.cancel()
            except Exception as exc:                   # broker hiccup — retry
                print(f"heartbeat failed: {exc}")


def _dry_run_outputs(workdir: Path) -> None:
    """Fabricate a minimal result so the full chain is testable without
    java/eqasim: an empty-but-valid duckdb + events file."""
    import duckdb
    out = workdir / "simulation_output"
    out.mkdir(parents=True, exist_ok=True)
    (out / "output_events.xml.gz").write_bytes(b"")
    web = out / "webmap"
    web.mkdir(exist_ok=True)
    con = duckdb.connect(str(web / "synthetic.duckdb"))
    con.execute("CREATE TABLE metadata_dummy(x INTEGER)")
    con.close()


def process_job(job: dict) -> None:
    job_id = job["job_id"]
    iterations = int(((job.get("diff") or {}).get("params") or {})
                     .get("iterations") or 40)
    workdir = WORK_ROOT / f"job_{job_id}"

    runner = ProcessRunner(
        on_iteration=lambda i: hb.set(
            phase="simulating",
            progress=0.05 + 0.80 * (i / max(1, iterations)),
            message=f"iteration {i}/{iterations}"))
    hb = Heartbeat(job_id, runner)
    hb.start()
    try:
        hb.set(phase="preparing", progress=0.01, message="copying bundle")
        prepare_workdir(job["bundle_path"], workdir)

        hb.set(message="applying scenario diff")
        report = apply_diff(workdir, job["diff"],
                            log=lambda m: runner.tail.append(str(m)))
        runner.tail.append(f"diff applied: {report}")
        if hb.cancelled.is_set():
            raise Cancelled("cancelled")

        output_dir = workdir / "simulation_output"
        if DRY_RUN:
            hb.set(phase="simulating", progress=0.5, message="DRY RUN")
            _dry_run_outputs(workdir)
        else:
            hb.set(phase="simulating", progress=0.05,
                   message=f"starting MATSim ({iterations} iterations)")
            runner.run(java_command(job, workdir, output_dir), workdir,
                       "simulation")

            hb.set(phase="exporting", progress=0.87, message="webmap export")
            from runner import EQASIM_REPO
            runner.run(export_command(workdir), Path(EQASIM_REPO), "export")

            events = output_dir / "output_events.xml.gz"
            duck = output_dir / "webmap" / "synthetic.duckdb"
            hb.set(phase="exporting", progress=0.93,
                   message="PT volumes retrofit")
            retrofit_transit_volumes(events, duck, runner)

        hb.set(phase="uploading", progress=0.96, message="uploading result")
        synthetic = workdir / "simulation_output" / "webmap" / "synthetic.duckdb"
        micro = Path(job["bundle_path"]) / "microcensus.duckdb"
        # Fresh user token just-in-time: a run may take days, the claim-time
        # token is only the fallback if the broker is briefly unreachable.
        try:
            upload_token = _api("POST", f"/worker/jobs/{job_id}/token")["user_token"]
        except Exception as exc:
            runner.tail.append(f"fresh-token fetch failed ({exc}) - "
                               "falling back to claim-time token")
            upload_token = job["user_token"]
        ds_id = upload_result(
            DATASET_API, upload_token, job["title"],
            {"base_dataset_id": job["base_dataset_id"],
             "summary": job.get("summary") or [],
             "params": job.get("diff", {}).get("params", {})},
            synthetic, micro if micro.exists() else None,
            log=lambda m: runner.tail.append(str(m)))

        _api("POST", f"/worker/jobs/{job_id}/complete",
             json={"result_dataset_id": ds_id})
        print(f"job {job_id} done -> dataset {ds_id}")
    except Cancelled:
        _api("POST", f"/worker/jobs/{job_id}/fail",
             json={"error": "cancelled by user", "cancelled": True})
        print(f"job {job_id} cancelled")
    except DiffError as exc:
        _api("POST", f"/worker/jobs/{job_id}/fail",
             json={"error": f"scenario error: {exc}"})
        print(f"job {job_id} diff error: {exc}")
    except Exception as exc:
        traceback.print_exc()
        _api("POST", f"/worker/jobs/{job_id}/fail",
             json={"error": f"{type(exc).__name__}: {exc}"[:3000]})
    finally:
        hb.stop()
        if os.getenv("KEEP_WORKDIR", "0") != "1":
            shutil.rmtree(workdir, ignore_errors=True)


def main() -> None:
    if not (BROKER_URL and WORKER_TOKEN and DATASET_API):
        raise SystemExit("BROKER_URL, SIM_WORKER_TOKEN and DATASET_API_URL "
                         "must be set")
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    print(f"sim-worker '{WORKER_ID}' polling {BROKER_URL} "
          f"(dry_run={DRY_RUN})")
    while True:
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

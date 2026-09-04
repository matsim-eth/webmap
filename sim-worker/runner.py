"""Subprocess plumbing for a job: the MATSim run, the eqasim trip/activity
analyses that feed the dataset ingest, and the workdir/checkpoint logic that
makes a run resumable."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from collections import deque
from pathlib import Path

MAIN_CLASS = "org.eqasim.switzerland.ch.RunSimulation"
TRIP_ANALYSIS = "org.eqasim.core.analysis.run.RunTripAnalysis"
ACTIVITY_ANALYSIS = "org.eqasim.core.analysis.run.RunActivityAnalysis"
_ITER_RE = re.compile(r"ITERATION (\d+) BEGINS")

#: Iteration plans are written every N iterations — the checkpoints a
#: resumed job continues from. Costs one plans file per N iterations.
PLANS_INTERVAL = max(1, int(os.getenv("PLANS_INTERVAL", "5")))

#: Files a finished MATSim run leaves in its output directory.
OUTPUT_FILES = {
    "network": "output_network.xml.gz",
    "events": "output_events.xml.gz",
    "transit_schedule": "output_transitSchedule.xml.gz",
    "plans": "output_plans.xml.gz",
    "facilities": "output_facilities.xml.gz",
}
#: What the dataset ingest needs from the base bundle (population attributes
#: never change in a scenario diff, so they come from the base run).
PERSON_FILES = ("persons.parquet", "persons.csv")
HOUSEHOLD_FILES = ("households.parquet", "households.csv")


class Cancelled(RuntimeError):
    pass


class ProcessRunner:
    """Streams a subprocess, keeps a log tail, reports iteration progress
    and supports cooperative cancellation."""

    def __init__(self, on_iteration=None, tail_lines: int = 120) -> None:
        self.tail: deque[str] = deque(maxlen=tail_lines)
        self._on_iteration = on_iteration
        self._proc: subprocess.Popen | None = None
        self._cancel = threading.Event()

    def cancel(self) -> None:
        self._cancel.set()
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    @property
    def log_tail(self) -> str:
        return "\n".join(self.tail)

    def run(self, cmd: list[str], cwd: Path, what: str) -> None:
        self.tail.append(f"$ {' '.join(cmd)}")
        self._proc = subprocess.Popen(
            cmd, cwd=str(cwd), stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, errors="replace")
        for line in self._proc.stdout:
            line = line.rstrip()
            if line:
                self.tail.append(line)
            m = _ITER_RE.search(line)
            if m and self._on_iteration:
                self._on_iteration(int(m.group(1)))
            if self._cancel.is_set():
                self._proc.terminate()
        rc = self._proc.wait()
        if self._cancel.is_set():
            raise Cancelled(f"{what} cancelled")
        if rc != 0:
            raise RuntimeError(f"{what} failed (exit {rc}). Log tail:\n"
                               + "\n".join(list(self.tail)[-25:]))


# ─── commands ────────────────────────────────────────────────────────────

def _java(job: dict) -> list[str]:
    return ["java", f"-Xmx{job.get('java_memory') or '64G'}",
            "-cp", job["jar_path"]]


def java_command(job: dict, workdir: Path, output_dir: Path,
                 first_iteration: int | None = None) -> list[str]:
    """The MATSim run. With *first_iteration* the run continues from the
    plans checkpoint of the iteration before it (see :func:`run_state`)."""
    params = (job.get("diff") or {}).get("params") or {}
    iterations = int(params.get("iterations") or 40)
    threads = int(job.get("threads") or 16)
    cmd = _java(job) + [
        MAIN_CLASS,
        "--config-path", str(workdir / job.get("config_name",
                                               "switzerland_config.xml")),
        "--config:controler.outputDirectory", str(output_dir),
        "--config:controler.lastIteration", str(iterations),
        "--config:controler.writeEventsInterval", str(iterations),
        "--config:controler.writePlansInterval", str(PLANS_INTERVAL),
        "--config:global.numberOfThreads", str(threads),
        "--config:qsim.numberOfThreads", str(min(threads, 16)),
    ]
    if first_iteration is not None:
        last = first_iteration - 1
        cmd += [
            "--config:controler.firstIteration", str(first_iteration),
            "--config:plans.inputPlansFile",
            str(checkpoint_plans(output_dir, last)),
            "--config:controler.overwriteFiles", "overwriteExistingFiles",
        ]
    else:
        cmd += ["--config:controler.overwriteFiles", "deleteDirectoryIfExists"]
    if params.get("random_seed") is not None:
        cmd += ["--config:global.randomSeed", str(params["random_seed"])]
    for k, v in (params.get("config_overrides") or {}).items():
        cmd += [f"--config:{k}", str(v)]
    return cmd


def analysis_commands(job: dict, output_dir: Path,
                      staging: Path) -> list[tuple[str, list[str]]]:
    """eqasim's trip + activity analyses over the run's events: they write
    the semicolon CSVs the dataset ingest reads (eqasim_trips.csv /
    eqasim_activities.csv), exactly as the reference pipeline does."""
    common = ["--events-path", str(output_dir / OUTPUT_FILES["events"]),
              "--network-path", str(output_dir / OUTPUT_FILES["network"]),
              "--delimiter", ";"]
    facilities = output_dir / OUTPUT_FILES["facilities"]
    if facilities.exists():
        common += ["--facilities-path", str(facilities)]
    return [
        ("trip analysis", _java(job) + [TRIP_ANALYSIS] + common
         + ["--output-path", str(staging / "eqasim_trips.csv")]),
        ("activity analysis", _java(job) + [ACTIVITY_ANALYSIS] + common
         + ["--output-path", str(staging / "eqasim_activities.csv")]),
    ]


# ─── workdir + checkpoints ───────────────────────────────────────────────

def prepare_workdir(bundle_path: str, workdir: Path) -> None:
    """Copy the base bundle into a fresh job working directory."""
    src = Path(bundle_path)
    if not src.is_dir():
        raise RuntimeError(f"bundle path not found: {src}")
    if workdir.exists():
        shutil.rmtree(workdir)
    shutil.copytree(src, workdir)


DIFF_MARKER = ".diff_applied.json"


def mark_diff_applied(workdir: Path, report: dict) -> None:
    """Written right after apply_diff succeeds. A resumed job only adopts a
    workdir that carries it — otherwise MATSim would run on the untouched
    base bundle."""
    import json
    (workdir / DIFF_MARKER).write_text(json.dumps(report, default=str))


def diff_applied(workdir: Path) -> bool:
    return (workdir / DIFF_MARKER).is_file()


def bundle_person_files(bundle_path: str) -> dict[str, Path]:
    """persons/households files the ingest needs, as found in the bundle.
    Raises before any compute is burned when persons are missing."""
    b = Path(bundle_path)
    out = {}
    for key, names in (("persons", PERSON_FILES), ("households", HOUSEHOLD_FILES)):
        for n in names:
            if (b / n).is_file():
                out[key] = b / n
                break
    if "persons" not in out:
        raise RuntimeError(
            f"bundle {b} has no {' / '.join(PERSON_FILES)} - the base run's "
            "person attributes are required to build the result dataset")
    return out


def checkpoint_plans(output_dir: Path, iteration: int) -> Path:
    return output_dir / "ITERS" / f"it.{iteration}" / f"{iteration}.plans.xml.gz"


def last_checkpoint(output_dir: Path) -> int:
    """Highest iteration with a plans checkpoint on disk (0 = none)."""
    iters = output_dir / "ITERS"
    if not iters.is_dir():
        return 0
    best = 0
    for d in iters.iterdir():
        m = re.fullmatch(r"it\.(\d+)", d.name)
        if m and checkpoint_plans(output_dir, int(m.group(1))).is_file():
            best = max(best, int(m.group(1)))
    return best


def run_state(output_dir: Path, iterations: int) -> tuple[str, int]:
    """What a (possibly interrupted) run left behind:

    ("done", n)   – final output files exist, skip straight to analysis
    ("resume", n) – checkpoint n exists, continue with iteration n + 1
    ("fresh", 0)  – nothing usable, start over
    """
    finals = [output_dir / OUTPUT_FILES[k]
              for k in ("network", "events", "transit_schedule")]
    if all(p.is_file() for p in finals):
        return "done", iterations
    n = last_checkpoint(output_dir)
    if 0 < n < iterations:
        return "resume", n
    return "fresh", 0


def prune_workdirs(work_root: Path, ttl_days: float) -> list[str]:
    """Delete job_* directories untouched for longer than *ttl_days* —
    kept after failures/cancels so a resume can continue, not forever."""
    import time
    cutoff = time.time() - ttl_days * 86400
    gone = []
    for d in work_root.glob("job_*"):
        try:
            if d.is_dir() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
                gone.append(d.name)
        except OSError:
            pass
    return gone

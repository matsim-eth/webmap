"""Run the eqasim/MATSim simulation and the webmap export as subprocesses."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from collections import deque
from pathlib import Path

MAIN_CLASS = "org.eqasim.switzerland.ch.RunSimulation"
_ITER_RE = re.compile(r"ITERATION (\d+) BEGINS")

EQASIM_REPO = os.getenv("EQASIM_REPO", "/opt/eqasim-switzerland")
EXPORT_PYTHON = os.getenv("EXPORT_PYTHON", "python3")


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


def java_command(job: dict, workdir: Path, output_dir: Path) -> list[str]:
    params = (job.get("diff") or {}).get("params") or {}
    iterations = int(params.get("iterations") or 40)
    threads = int(job.get("threads") or 16)
    cmd = [
        "java", f"-Xmx{job.get('java_memory') or '64G'}",
        "-cp", job["jar_path"], MAIN_CLASS,
        "--config-path", str(workdir / job.get("config_name",
                                               "switzerland_config.xml")),
        "--config:controler.outputDirectory", str(output_dir),
        "--config:controler.lastIteration", str(iterations),
        "--config:controler.writeEventsInterval", str(iterations),
        "--config:controler.writePlansInterval", str(iterations),
        "--config:global.numberOfThreads", str(threads),
        "--config:qsim.numberOfThreads", str(min(threads, 16)),
        "--config:controler.overwriteFiles", "deleteDirectoryIfExists",
    ]
    if params.get("random_seed") is not None:
        cmd += ["--config:global.randomSeed", str(params["random_seed"])]
    for k, v in (params.get("config_overrides") or {}).items():
        cmd += [f"--config:{k}", str(v)]
    return cmd


def export_command(workdir: Path) -> list[str]:
    """webmap_export standalone against the finished run. *workdir* mimics a
    run cache: it contains simulation_output/ (we add the completion marker
    the exporter looks for)."""
    (workdir / "run_custom.p").touch()
    return [EXPORT_PYTHON, "-m", "analysis.webmap_export.run_standalone",
            "synthetic", "--matsim-dir", str(workdir)]


def retrofit_transit_volumes(events: Path, duckdb_file: Path,
                             runner: ProcessRunner) -> None:
    """Our own PT-passenger-volumes retrofit (scripts/build_transit_volumes,
    vendored into the image) so custom runs feed the Transit Volumes module."""
    script_dir = os.getenv("TRANSIT_VOLUMES_DIR", "/opt/build_transit_volumes")
    if not Path(script_dir, "main.py").exists():
        runner.tail.append("transit-volumes retrofit skipped (script not found)")
        return
    runner.run([EXPORT_PYTHON, "main.py", "--events", str(events),
                "--db", str(duckdb_file)],
               cwd=Path(script_dir), what="transit volumes retrofit")


def prepare_workdir(bundle_path: str, workdir: Path) -> None:
    """Copy the base bundle into the job working directory."""
    src = Path(bundle_path)
    if not src.is_dir():
        raise RuntimeError(f"bundle path not found: {src}")
    if workdir.exists():
        shutil.rmtree(workdir)
    shutil.copytree(src, workdir)

"""Command building, checkpoint detection and bundle checks."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import runner  # noqa: E402
from runner import (analysis_commands, bundle_person_files, java_command,  # noqa: E402
                    last_checkpoint, prune_workdirs, run_state)

JOB = {"jar_path": "/bundles/b/eqasim.jar", "java_memory": "8G", "threads": 4,
       "diff": {"params": {"iterations": 20, "random_seed": 7}}}


def _checkpoint(out: Path, n: int) -> None:
    d = out / "ITERS" / f"it.{n}"
    d.mkdir(parents=True)
    (d / f"{n}.plans.xml.gz").write_bytes(b"x")


def test_java_command_fresh(tmp_path):
    cmd = java_command(JOB, tmp_path, tmp_path / "out")
    s = " ".join(cmd)
    assert cmd[:3] == ["java", "-Xmx8G", "-cp"]
    assert "--config:controler.lastIteration 20" in s
    assert "--config:controler.writePlansInterval" in s
    assert "--config:controler.overwriteFiles deleteDirectoryIfExists" in s
    assert "--config:global.randomSeed 7" in s
    assert "firstIteration" not in s


def test_java_command_resume(tmp_path):
    out = tmp_path / "out"
    cmd = java_command(JOB, tmp_path, out, first_iteration=11)
    s = " ".join(cmd)
    assert "--config:controler.firstIteration 11" in s
    assert f"--config:plans.inputPlansFile {out / 'ITERS' / 'it.10' / '10.plans.xml.gz'}" in s
    assert "--config:controler.overwriteFiles overwriteExistingFiles" in s


def test_run_state(tmp_path):
    out = tmp_path / "out"
    assert run_state(out, 20) == ("fresh", 0)
    _checkpoint(out, 5)
    _checkpoint(out, 10)
    (out / "ITERS" / "it.15").mkdir()            # dir without plans: ignored
    assert last_checkpoint(out) == 10
    assert run_state(out, 20) == ("resume", 10)
    _checkpoint(out, 20)                           # last iteration = nothing to resume
    assert run_state(out, 20) == ("fresh", 0)
    for n in ("output_network.xml.gz", "output_events.xml.gz",
              "output_transitSchedule.xml.gz"):
        (out / n).write_bytes(b"x")
    assert run_state(out, 20) == ("done", 20)


def test_analysis_commands(tmp_path):
    out, staging = tmp_path / "out", tmp_path / "staging"
    out.mkdir()
    cmds = analysis_commands(JOB, out, staging)
    assert [w for w, _ in cmds] == ["trip analysis", "activity analysis"]
    trip = " ".join(cmds[0][1])
    assert runner.TRIP_ANALYSIS in trip
    assert f"--events-path {out / 'output_events.xml.gz'}" in trip
    assert f"--output-path {staging / 'eqasim_trips.csv'}" in trip
    assert "--delimiter ;" in trip
    assert "--facilities-path" not in trip
    (out / "output_facilities.xml.gz").write_bytes(b"x")
    assert "--facilities-path" in " ".join(analysis_commands(JOB, out, staging)[1][1])


def test_bundle_person_files(tmp_path):
    with pytest.raises(RuntimeError, match="persons"):
        bundle_person_files(str(tmp_path))
    (tmp_path / "persons.csv").write_text("person_id\n")
    assert bundle_person_files(str(tmp_path)) == {"persons": tmp_path / "persons.csv"}
    (tmp_path / "persons.parquet").write_bytes(b"p")    # parquet wins
    (tmp_path / "households.csv").write_text("household_id\n")
    files = bundle_person_files(str(tmp_path))
    assert files["persons"].name == "persons.parquet"
    assert files["households"].name == "households.csv"


def test_prune_workdirs(tmp_path):
    old, new = tmp_path / "job_1", tmp_path / "job_2"
    old.mkdir(); new.mkdir()
    stale = time.time() - 10 * 86400
    os.utime(old, (stale, stale))
    assert prune_workdirs(tmp_path, ttl_days=7) == ["job_1"]
    assert not old.exists() and new.exists()


def test_diff_marker(tmp_path):
    from runner import diff_applied, mark_diff_applied
    assert not diff_applied(tmp_path)
    mark_diff_applied(tmp_path, {"operations": [{"op": "close_links", "links": 1}]})
    assert diff_applied(tmp_path)

"""publish_result against a mocked dataset API: create (with name-conflict
retry) → microcensus upload → multipart ingest → status polling → validate;
and the cleanup on a failed build."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from uploader import DatasetApi, IngestFailed, publish_result, result_description  # noqa: E402


class FakeDatasetApi:
    def __init__(self, ingest_states):
        self.calls = []
        self.states = list(ingest_states)
        self.ingest_parts = None
        self.ingest_form = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))
        assert request.headers.get("cookie", "").startswith("access_token=tok")
        if request.method == "POST" and path == "/api/datasets":
            body = json.loads(request.read())
            if body["name"] == "Run":                 # first name is taken
                return httpx.Response(409, json={"detail": "name taken"})
            return httpx.Response(201, json={"id": 42, "name": body["name"]})
        if path == "/api/datasets/42/upload/microcensus":
            return httpx.Response(200, json={"uploaded": "microcensus.duckdb"})
        if path == "/api/datasets/42/ingest":
            raw = request.read()
            self.ingest_parts = [n for n in ("trips", "activities", "network",
                                             "events", "transit_schedule",
                                             "plans", "persons", "households")
                                 if f'name="{n}"'.encode() in raw]
            self.ingest_form = raw
            return httpx.Response(202, json={"state": "running"})
        if path == "/api/datasets/42/ingest/status":
            return httpx.Response(200, json=self.states.pop(0))
        if path == "/api/datasets/42/validate":
            return httpx.Response(200, json={})
        if request.method == "DELETE" and path == "/api/datasets/42":
            return httpx.Response(204)
        return httpx.Response(404, json={"detail": path})


@pytest.fixture()
def files(tmp_path):
    out = {}
    for key, name in (("trips", "eqasim_trips.csv"), ("activities", "eqasim_activities.csv"),
                      ("network", "output_network.xml.gz"), ("events", "output_events.xml.gz"),
                      ("transit_schedule", "output_transitSchedule.xml.gz"),
                      ("plans", "output_plans.xml.gz"), ("persons", "persons.parquet"),
                      ("households", "households.csv")):
        p = tmp_path / name
        p.write_bytes(b"data")
        out[key] = p
    return out


LINEAGE = {"base_dataset_id": 1, "summary": ["close 1 link(s)"], "params": {"iterations": 5}}


def test_publish_happy_path(files, tmp_path):
    fake = FakeDatasetApi([
        {"state": "running", "step": "network", "progress": 0.1},
        {"state": "running", "step": "trips", "progress": 0.3},
        {"state": "done", "step": "indexes", "progress": 1.0},
    ])
    api = DatasetApi("http://x/api", "tok", transport=httpx.MockTransport(fake.handler))
    micro = tmp_path / "microcensus.duckdb"
    micro.write_bytes(b"m")
    progress = []
    ds = publish_result(api, "Run", "Closes the bridge.", LINEAGE, files, micro,
                        run_name="sim job 1", sample_rate=0.01, log=lambda m: None,
                        on_ingest_progress=lambda p, s: progress.append((p, s)))
    assert ds == 42
    assert fake.ingest_parts == ["trips", "activities", "network", "events",
                                 "transit_schedule", "plans", "persons", "households"]
    assert b'name="sample_rate"\r\n\r\n0.01' in fake.ingest_form
    assert b'filename="persons.parquet"' in fake.ingest_form
    assert progress == [(0.1, "network"), (0.3, "trips")]
    methods = [c for c in fake.calls]
    assert methods[0] == ("POST", "/api/datasets") and methods[1] == ("POST", "/api/datasets")
    assert ("POST", "/api/datasets/42/upload/microcensus") in methods
    assert methods[-1] == ("POST", "/api/datasets/42/validate")
    assert ("DELETE", "/api/datasets/42") not in methods


def test_publish_ingest_error_deletes_dataset(files):
    fake = FakeDatasetApi([{"state": "running", "step": "network", "progress": 0.1},
                           {"state": "error", "detail": "events file truncated"}])
    api = DatasetApi("http://x/api", "tok", transport=httpx.MockTransport(fake.handler))
    with pytest.raises(IngestFailed, match="truncated"):
        publish_result(api, "Other", "", LINEAGE, files, None, run_name="j",
                       sample_rate=None, log=lambda m: None)
    assert fake.calls[-1] == ("DELETE", "/api/datasets/42")


def test_result_description():
    d = result_description("Closes the bridge.", LINEAGE)
    assert d.startswith("Closes the bridge.\n\n")
    assert "dataset #1" in d and "close 1 link(s)" in d and "5 iterations" in d
    assert result_description("  ", LINEAGE).startswith("Custom simulation run")

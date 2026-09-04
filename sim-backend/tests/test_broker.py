"""DSL validation + full broker job lifecycle (sqlite, stubbed dataset
service): propose → confirm → claim → progress → complete, plus quota,
cancel and permission gates."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
import pytest

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["SIM_WORKER_TOKEN"] = "worker-secret"
os.environ["SIM_MAX_ACTIVE_PER_USER"] = "1"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402
from dsl import ScenarioDiff, summarize  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def token(user_id: int, admin: bool = False) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": str(user_id), "typ": "access", "admin": admin,
                       "username": f"user{user_id}",
                       "exp": now + timedelta(hours=1)},
                      "test-secret", algorithm="HS256")


@pytest.fixture()
def client(monkeypatch):
    async def _ok(dataset_id, user):        # dataset service stub
        return None
    monkeypatch.setattr(main, "_check_dataset_access", _ok)
    with TestClient(main.app) as c:
        # register a scenario bundle (admin)
        r = c.post("/scenarios", cookies={"access_token": token(9, admin=True)},
                   json={"dataset_id": 1, "bundle_path": "/bundles/base1",
                         "jar_path": "/bundles/base1/eqasim.jar",
                         "minutes_per_iteration": 3.0})
        assert r.status_code == 200, r.text
        yield c


DIFF = {
    "base_dataset_id": 1,
    "title": "No Hardbrücke",
    "operations": [
        {"op": "close_links", "select": {"link_ids": ["103313"]}},
        {"op": "scale_transit_frequency",
         "select": {"filter": {"name_contains": "80"}}, "factor": 2},
    ],
    "params": {"iterations": 20},
}


# ─── DSL unit checks ─────────────────────────────────────────────────────

def test_dsl_valid_and_summary():
    d = ScenarioDiff.model_validate(DIFF)
    lines = summarize(d)
    assert len(lines) == 2 and "close 1 link(s)" in lines[0]


@pytest.mark.parametrize("broken", [
    # unknown field
    {**DIFF, "operations": [{"op": "close_links",
                             "select": {"link_ids": ["x"]}, "colour": "red"}]},
    # both selector kinds
    {**DIFF, "operations": [{"op": "close_links",
                             "select": {"link_ids": ["x"],
                                        "filter": {"modes_any": ["car"]}}}]},
    # empty filter
    {**DIFF, "operations": [{"op": "close_links", "select": {"filter": {}}}]},
    # modify without change
    {**DIFF, "operations": [{"op": "modify_links",
                             "select": {"link_ids": ["x"]}}]},
    # bad factor
    {**DIFF, "operations": [{"op": "scale_transit_frequency",
                             "select": {"line_ids": ["l"]}, "factor": 99}]},
    # bad override key
    {**DIFF, "params": {"iterations": 5,
                        "config_overrides": {"rm -rf /": "1"}}},
    # unknown op
    {**DIFF, "operations": [{"op": "teleport_everyone"}]},
])
def test_dsl_rejects(broken):
    with pytest.raises(Exception):
        ScenarioDiff.model_validate(broken)


# ─── Broker lifecycle ────────────────────────────────────────────────────

def test_full_lifecycle(client):
    u = {"access_token": token(1)}

    r = client.post("/proposals", cookies=u, json=DIFF)
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["status"] == "proposed"
    assert "~1.0 h" in job["estimate"]
    jid = job["job_id"]

    # worker sees nothing before confirmation
    r = client.post("/worker/claim", headers={"X-Worker-Token": "worker-secret"})
    assert r.json()["job"] is None

    r = client.post(f"/jobs/{jid}/confirm", cookies=u)
    assert r.json()["status"] == "queued"

    # quota: second proposal while one active
    r = client.post("/proposals", cookies=u, json=DIFF)
    assert r.status_code == 429

    # claim
    r = client.post("/worker/claim", headers={"X-Worker-Token": "worker-secret",
                                              "X-Worker-Id": "worker-1"})
    claimed = r.json()["job"]
    assert claimed["job_id"] == jid
    assert claimed["bundle_path"] == "/bundles/base1"
    assert claimed["threads"] == 16
    # minted token belongs to the submitting user
    claims = jwt.decode(claimed["user_token"], "test-secret",
                        algorithms=["HS256"])
    assert claims["sub"] == "1" and claims["typ"] == "access"

    # fresh upload token minted on demand (JIT — long runs never outlive it)
    r = client.post(f"/worker/jobs/{jid}/token",
                    headers={"X-Worker-Token": "worker-secret"})
    fresh = jwt.decode(r.json()["user_token"], "test-secret",
                       algorithms=["HS256"])
    assert fresh["sub"] == "1" and fresh["typ"] == "access"

    # progress + no cancel requested
    r = client.post(f"/worker/jobs/{jid}/progress",
                    headers={"X-Worker-Token": "worker-secret"},
                    json={"phase": "simulating", "progress": 0.4,
                          "message": "iteration 8/20", "log_tail": "..."})
    assert r.json() == {"cancel_requested": False}

    r = client.get(f"/jobs/{jid}", cookies=u)
    body = r.json()
    assert body["phase"] == "simulating" and body["progress"] == 0.4

    # complete
    r = client.post(f"/worker/jobs/{jid}/complete",
                    headers={"X-Worker-Token": "worker-secret"},
                    json={"result_dataset_id": 77})
    assert r.json()["ok"]
    r = client.get(f"/jobs/{jid}", cookies=u)
    assert r.json()["status"] == "done"
    assert r.json()["result_dataset_id"] == 77

    # quota freed again
    r = client.post("/proposals", cookies=u, json=DIFF)
    assert r.status_code == 200


def test_cancel_running(client):
    u = {"access_token": token(2)}
    jid = client.post("/proposals", cookies=u, json=DIFF).json()["job_id"]
    client.post(f"/jobs/{jid}/confirm", cookies=u)
    client.post("/worker/claim", headers={"X-Worker-Token": "worker-secret"})

    client.post(f"/jobs/{jid}/cancel", cookies=u)
    r = client.post(f"/worker/jobs/{jid}/progress",
                    headers={"X-Worker-Token": "worker-secret"},
                    json={"phase": "simulating", "progress": 0.2})
    assert r.json()["cancel_requested"] is True
    client.post(f"/worker/jobs/{jid}/fail",
                headers={"X-Worker-Token": "worker-secret"},
                json={"error": "cancelled by user", "cancelled": True})
    assert client.get(f"/jobs/{jid}", cookies=u).json()["status"] == "cancelled"


def test_gates(client):
    u = {"access_token": token(3)}
    # config_overrides are admin-only
    r = client.post("/proposals", cookies=u, json={
        **DIFF, "params": {"iterations": 5,
                           "config_overrides": {"qsim.flowCapacityFactor": "0.5"}}})
    assert r.status_code == 403
    # unknown base dataset bundle
    r = client.post("/proposals", cookies=u, json={**DIFF, "base_dataset_id": 999})
    assert r.status_code == 409
    # foreign job invisible
    jid = client.post("/proposals", cookies=u, json=DIFF).json()["job_id"]
    r = client.get(f"/jobs/{jid}", cookies={"access_token": token(4)})
    assert r.status_code == 404
    # wrong worker token
    r = client.post("/worker/claim", headers={"X-Worker-Token": "wrong"})
    assert r.status_code == 401


# ─── Description + resume ────────────────────────────────────────────────

def test_description_roundtrip(client):
    u = {"access_token": token(7)}
    body = {**DIFF, "description": "Closes the bridge to see where traffic goes."}
    job = client.post("/proposals", cookies=u, json=body).json()
    assert job["description"] == body["description"]
    assert client.get(f"/jobs/{job['job_id']}", cookies=u).json()["description"] \
        == body["description"]
    client.post(f"/jobs/{job['job_id']}/confirm", cookies=u)
    claimed = client.post("/worker/claim",
                          headers={"X-Worker-Token": "worker-secret"}).json()["job"]
    assert claimed["description"] == body["description"]
    assert claimed["resume_of"] is None


def test_resume_flow(client):
    w1 = {"X-Worker-Token": "worker-secret", "X-Worker-Id": "worker-1"}
    w2 = {"X-Worker-Token": "worker-secret", "X-Worker-Id": "worker-2"}
    u = {"access_token": token(8)}

    # a proposal that was never confirmed cannot be resumed
    jid0 = client.post("/proposals", cookies=u, json=DIFF).json()["job_id"]
    client.post(f"/jobs/{jid0}/cancel", cookies=u)
    assert client.post(f"/jobs/{jid0}/resume", cookies=u).status_code == 409

    # run on worker-1, cancel it mid-way
    jid = client.post("/proposals", cookies=u, json=DIFF).json()["job_id"]
    client.post(f"/jobs/{jid}/confirm", cookies=u)
    assert client.post("/worker/claim", headers=w1).json()["job"]["job_id"] == jid
    client.post(f"/jobs/{jid}/cancel", cookies=u)
    client.post(f"/worker/jobs/{jid}/fail", headers=w1,
                json={"error": "cancelled by user", "cancelled": True})
    assert client.get(f"/jobs/{jid}", cookies=u).json()["status"] == "cancelled"

    # somebody else's job queued EARLIER (admin: no quota) ...
    a = {"access_token": token(9, admin=True)}
    other = client.post("/proposals", cookies=a, json=DIFF).json()["job_id"]
    client.post(f"/jobs/{other}/confirm", cookies=a)

    # ... resume → new queued job, bound to worker-1
    r = client.post(f"/jobs/{jid}/resume", cookies=u)
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["status"] == "queued" and new["resume_of"] == jid
    assert new["title"] == "No Hardbrücke"
    # a second resume of the same run is refused while the first is active
    assert client.post(f"/jobs/{jid}/resume", cookies=u).status_code == 409

    # worker-1 gets the resumed job first (affinity beats FIFO); worker-2
    # gets the older plain job
    c1 = client.post("/worker/claim", headers=w1).json()["job"]
    assert c1["job_id"] == new["job_id"] and c1["resume_of"] == jid
    c2 = client.post("/worker/claim", headers=w2).json()["job"]
    assert c2["job_id"] == other


def test_resume_refused_for_scenario_errors(client):
    u = {"access_token": token(10)}
    w = {"X-Worker-Token": "worker-secret", "X-Worker-Id": "worker-1"}
    jid = client.post("/proposals", cookies=u, json=DIFF).json()["job_id"]
    client.post(f"/jobs/{jid}/confirm", cookies=u)
    client.post("/worker/claim", headers=w)
    client.post(f"/worker/jobs/{jid}/fail", headers=w,
                json={"error": "scenario error: unknown link id(s): ['x']"})
    r = client.post(f"/jobs/{jid}/resume", cookies=u)
    assert r.status_code == 409 and "propose a new run" in r.json()["detail"]

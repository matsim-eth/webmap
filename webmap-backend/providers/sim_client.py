"""Thin client for the sim broker (custom MATSim runs).

Used by the website agent (per-request user token) and the MCP server.
All calls are synchronous httpx — callers run in worker threads.
"""

from __future__ import annotations

import os

import httpx

SIM_SERVICE_URL = os.getenv("SIM_SERVICE_URL", "").rstrip("/")


def available() -> bool:
    return bool(SIM_SERVICE_URL)


class SimError(RuntimeError):
    pass


def _call(method: str, path: str, token: str, json_body: dict | None = None) -> dict:
    if not SIM_SERVICE_URL:
        raise SimError("simulation service is not configured")
    try:
        r = httpx.request(method, f"{SIM_SERVICE_URL}{path}",
                          cookies={"access_token": token},
                          json=json_body, timeout=20.0)
    except httpx.HTTPError as exc:
        raise SimError(f"simulation service unreachable: {exc}") from exc
    if r.status_code >= 300:
        try:
            detail = r.json().get("detail", r.text)
        except Exception:
            detail = r.text
        raise SimError(f"{detail}"[:1200])
    return r.json()


def propose(token: str, diff: dict) -> dict:
    return _call("POST", "/proposals", token, diff)


def confirm(token: str, job_id: int) -> dict:
    return _call("POST", f"/jobs/{int(job_id)}/confirm", token)


def cancel(token: str, job_id: int) -> dict:
    return _call("POST", f"/jobs/{int(job_id)}/cancel", token)


def job_status(token: str, job_id: int) -> dict:
    return _call("GET", f"/jobs/{int(job_id)}", token)


def list_jobs(token: str) -> dict:
    return _call("GET", "/jobs", token)

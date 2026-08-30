"""Sim broker — custom MATSim/eqasim runs as a service.

Lifecycle:  propose (validated diff, quota, access check)
          → confirm (explicit user consent — simulations are expensive)
          → claim   (worker pulls, no inbound connections to compute)
          → progress heartbeats → complete/fail
Result datasets are created by the worker UNDER THE SUBMITTING USER via a
short-lived minted token, so ownership/grants work like any upload.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import func, select

import auth
from auth import User, mint_user_token, require_user, require_worker
from db import SessionLocal, SimJob, SimScenario, create_tables
from dsl import ScenarioDiff, summarize

APP_NAME = os.getenv("APP_NAME", "sim-backend")
ENV = os.getenv("ENV", "dev")
DATASET_SERVICE_URL = os.getenv("DATASET_SERVICE_URL", "http://dataset_backend:5033")
MAX_ACTIVE_PER_USER = int(os.getenv("SIM_MAX_ACTIVE_PER_USER", "2"))
PROPOSAL_TTL_MIN = int(os.getenv("SIM_PROPOSAL_TTL_MIN", "120"))

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(APP_NAME)

app = FastAPI(title=APP_NAME, root_path=os.getenv("ROOT_PATH", ""),
              docs_url=None if ENV == "prod" else "/docs",
              redoc_url=None, openapi_url=None if ENV == "prod" else "/openapi.json")


@app.on_event("startup")
async def _startup() -> None:
    await create_tables()
    if not auth.WORKER_TOKEN:
        logger.warning("SIM_WORKER_TOKEN is not set - workers cannot connect")


def _now() -> datetime:
    return datetime.now(timezone.utc)


ACTIVE = ("queued", "running", "uploading")


async def _check_dataset_access(dataset_id: int, user: User) -> None:
    """Same authority as everywhere else: the dataset service decides."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(
                f"{DATASET_SERVICE_URL}/datasets/{dataset_id}/resolve",
                cookies={"access_token": user.raw_token})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502,
                            detail=f"dataset service unreachable: {exc}")
    if r.status_code != 200:
        raise HTTPException(status_code=403,
                            detail=f"no access to dataset {dataset_id}")


def _job_out(j: SimJob, full: bool = False) -> dict:
    out = {
        "job_id": j.id, "title": j.title, "status": j.status,
        "base_dataset_id": j.base_dataset_id,
        "summary": j.summary, "estimate": j.estimate,
        "phase": j.phase, "progress": round(j.progress, 3),
        "message": j.message, "error": j.error or None,
        "result_dataset_id": j.result_dataset_id,
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
    }
    if full:
        out["operations"] = (j.diff or {}).get("operations", [])
        out["params"] = (j.diff or {}).get("params", {})
        out["log_tail"] = j.log_tail[-4000:] if j.log_tail else ""
    return out


# ─── User API ────────────────────────────────────────────────────────────

@app.post("/proposals")
async def create_proposal(request: Request, user: User = Depends(require_user)):
    body = await request.json()
    try:
        diff = ScenarioDiff.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:2000])

    if diff.params.config_overrides and not user.admin:
        raise HTTPException(status_code=403,
                            detail="config_overrides are admin-only")

    await _check_dataset_access(diff.base_dataset_id, user)

    async with SessionLocal() as db:
        scenario = await db.get(SimScenario, diff.base_dataset_id)
        if scenario is None:
            raise HTTPException(
                status_code=409,
                detail=f"dataset {diff.base_dataset_id} has no simulation "
                       "bundle registered - custom runs are only possible on "
                       "base datasets an admin has registered via /scenarios")

        if not user.admin:
            active = await db.scalar(
                select(func.count()).select_from(SimJob)
                .where(SimJob.user_id == user.id, SimJob.status.in_(ACTIVE)))
            if active >= MAX_ACTIVE_PER_USER:
                raise HTTPException(
                    status_code=429,
                    detail=f"quota: {active} simulation(s) already queued or "
                           f"running (max {MAX_ACTIVE_PER_USER})")

        if scenario.minutes_per_iteration:
            mins = scenario.minutes_per_iteration * diff.params.iterations
            estimate = f"~{mins / 60:.1f} h ({diff.params.iterations} iterations)"
        else:
            estimate = f"{diff.params.iterations} iterations (runtime unknown)"

        job = SimJob(user_id=user.id, username=user.username,
                     title=diff.title, base_dataset_id=diff.base_dataset_id,
                     diff=diff.model_dump(mode="json"),
                     summary=summarize(diff), estimate=estimate)
        db.add(job)
        await db.commit()
        await db.refresh(job)
        logger.info("proposal %s by user %s: %s", job.id, user.id, job.summary)
        return {**_job_out(job),
                "note": "not started - call POST /jobs/{id}/confirm after the "
                        "user explicitly approved"}


@app.post("/jobs/{job_id}/confirm")
async def confirm_job(job_id: int, user: User = Depends(require_user)):
    async with SessionLocal() as db:
        job = await db.get(SimJob, job_id)
        if job is None or (job.user_id != user.id and not user.admin):
            raise HTTPException(status_code=404, detail="job not found")
        if job.status != "proposed":
            raise HTTPException(status_code=409,
                                detail=f"job is {job.status}, not proposed")
        age_min = (_now() - job.created_at.replace(
            tzinfo=timezone.utc) if job.created_at.tzinfo is None
            else _now() - job.created_at).total_seconds() / 60
        if age_min > PROPOSAL_TTL_MIN:
            job.status = "cancelled"
            job.error = "proposal expired"
            await db.commit()
            raise HTTPException(status_code=410, detail="proposal expired - "
                                                        "propose again")
        job.status = "queued"
        job.confirmed_at = _now()
        await db.commit()
        logger.info("job %s confirmed by user %s", job.id, user.id)
        return _job_out(job)


@app.get("/jobs")
async def list_jobs(all: int = 0, user: User = Depends(require_user)):
    async with SessionLocal() as db:
        q = select(SimJob).order_by(SimJob.created_at.desc()).limit(100)
        if not (all and user.admin):
            q = q.where(SimJob.user_id == user.id)
        jobs = (await db.scalars(q)).all()
        return {"jobs": [_job_out(j) for j in jobs]}


@app.get("/jobs/{job_id}")
async def get_job(job_id: int, user: User = Depends(require_user)):
    async with SessionLocal() as db:
        job = await db.get(SimJob, job_id)
        if job is None or (job.user_id != user.id and not user.admin):
            raise HTTPException(status_code=404, detail="job not found")
        return _job_out(job, full=True)


@app.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: int, user: User = Depends(require_user)):
    async with SessionLocal() as db:
        job = await db.get(SimJob, job_id)
        if job is None or (job.user_id != user.id and not user.admin):
            raise HTTPException(status_code=404, detail="job not found")
        if job.status in ("proposed", "queued"):
            job.status = "cancelled"
            job.finished_at = _now()
        elif job.status in ("running", "uploading"):
            job.cancel_requested = True   # worker stops at next heartbeat
        else:
            raise HTTPException(status_code=409,
                                detail=f"job already {job.status}")
        await db.commit()
        return _job_out(job)


# ─── Scenario registry (admin) ───────────────────────────────────────────

class ScenarioIn(BaseModel):
    dataset_id: int = Field(ge=1)
    bundle_path: str = Field(min_length=1)
    jar_path: str = Field(min_length=1)
    config_name: str = "switzerland_config.xml"
    java_memory: str = "64G"
    threads: int = Field(default=16, ge=1, le=256)
    minutes_per_iteration: float | None = Field(default=None, gt=0)
    notes: str = ""


@app.post("/scenarios")
async def register_scenario(body: ScenarioIn, user: User = Depends(require_user)):
    if not user.admin:
        raise HTTPException(status_code=403, detail="admin only")
    async with SessionLocal() as db:
        existing = await db.get(SimScenario, body.dataset_id)
        if existing:
            for k, v in body.model_dump().items():
                setattr(existing, k, v)
        else:
            db.add(SimScenario(**body.model_dump()))
        await db.commit()
    return {"ok": True, "dataset_id": body.dataset_id}


@app.get("/scenarios")
async def list_scenarios(user: User = Depends(require_user)):
    async with SessionLocal() as db:
        rows = (await db.scalars(select(SimScenario))).all()
        return {"scenarios": [{
            "dataset_id": s.dataset_id, "config_name": s.config_name,
            "threads": s.threads, "java_memory": s.java_memory,
            "minutes_per_iteration": s.minutes_per_iteration,
            "notes": s.notes,
            # bundle/jar paths are worker-internal - admins see them:
            **({"bundle_path": s.bundle_path, "jar_path": s.jar_path}
               if user.admin else {}),
        } for s in rows]}


# ─── Worker API ──────────────────────────────────────────────────────────

@app.post("/worker/claim")
async def worker_claim(worker_id: str = Depends(require_worker)):
    async with SessionLocal() as db:
        job = (await db.scalars(
            select(SimJob).where(SimJob.status == "queued")
            .order_by(SimJob.confirmed_at).limit(1)
            .with_for_update(skip_locked=True))).first()
        if job is None:
            return {"job": None}
        scenario = await db.get(SimScenario, job.base_dataset_id)
        if scenario is None:                      # registered then deleted
            job.status = "failed"
            job.error = "scenario bundle no longer registered"
            job.finished_at = _now()
            await db.commit()
            return {"job": None}
        job.status = "running"
        job.worker_id = worker_id
        job.started_at = _now()
        job.phase = "claimed"
        await db.commit()
        logger.info("job %s claimed by %s", job.id, worker_id)
        return {"job": {
            "job_id": job.id,
            "title": job.title,
            "base_dataset_id": job.base_dataset_id,
            "summary": job.summary,
            "diff": job.diff,
            "bundle_path": scenario.bundle_path,
            "jar_path": scenario.jar_path,
            "config_name": scenario.config_name,
            "java_memory": scenario.java_memory,
            "threads": scenario.threads,
            "user_token": mint_user_token(job.user_id, job.username),
        }}


@app.post("/worker/jobs/{job_id}/token")
async def worker_fresh_token(job_id: int,
                             worker_id: str = Depends(require_worker)):
    """Fresh user token minted just-in-time (workers call this right before
    the upload, so even multi-day simulations never outlive their token —
    the claim-time token is only a fallback)."""
    async with SessionLocal() as db:
        job = await db.get(SimJob, job_id)
        if job is None or job.status not in ("running", "uploading"):
            raise HTTPException(status_code=409, detail="job not running")
        return {"user_token": mint_user_token(job.user_id, job.username)}


class ProgressIn(BaseModel):
    phase: str = ""
    progress: float = Field(default=0, ge=0, le=1)
    message: str = ""
    log_tail: str = ""


@app.post("/worker/jobs/{job_id}/progress")
async def worker_progress(job_id: int, body: ProgressIn,
                          worker_id: str = Depends(require_worker)):
    async with SessionLocal() as db:
        job = await db.get(SimJob, job_id)
        if job is None or job.status not in ("running", "uploading"):
            raise HTTPException(status_code=409, detail="job not running")
        job.phase = body.phase or job.phase
        job.progress = body.progress or job.progress
        job.message = body.message or job.message
        if body.log_tail:
            job.log_tail = body.log_tail[-8000:]
        if body.phase == "uploading":
            job.status = "uploading"
        await db.commit()
        return {"cancel_requested": job.cancel_requested}


class CompleteIn(BaseModel):
    result_dataset_id: int


@app.post("/worker/jobs/{job_id}/complete")
async def worker_complete(job_id: int, body: CompleteIn,
                          worker_id: str = Depends(require_worker)):
    async with SessionLocal() as db:
        job = await db.get(SimJob, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        job.status = "done"
        job.progress = 1.0
        job.phase = "done"
        job.result_dataset_id = body.result_dataset_id
        job.finished_at = _now()
        await db.commit()
        logger.info("job %s done -> dataset %s", job_id, body.result_dataset_id)
        return {"ok": True}


class FailIn(BaseModel):
    error: str = ""
    cancelled: bool = False


@app.post("/worker/jobs/{job_id}/fail")
async def worker_fail(job_id: int, body: FailIn,
                      worker_id: str = Depends(require_worker)):
    async with SessionLocal() as db:
        job = await db.get(SimJob, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        job.status = "cancelled" if body.cancelled else "failed"
        job.error = body.error[:4000]
        job.finished_at = _now()
        await db.commit()
        logger.warning("job %s %s: %s", job_id, job.status, body.error[:200])
        return {"ok": True}


@app.get("/health")
async def health():
    return {"status": "ok", "env": ENV}

"""Publish a finished run as a dataset OF THE SUBMITTING USER.

Talks to the public dataset API with the short-lived user token minted by the
broker — ownership, grants and quotas apply exactly as for a manual upload.
The raw MATSim outputs go through the platform's own ingest
(``POST /datasets/{id}/ingest``), so a custom run's duckdb is built by the
same code as every other dataset and never drifts from the schema the
frontends expect.
"""

from __future__ import annotations

import time
from pathlib import Path

import httpx

TIMEOUT = httpx.Timeout(60.0, read=600.0, write=7200.0)

#: multipart field → (staged file name, content type)
_INGEST_PARTS = {
    "trips": ("eqasim_trips.csv", "text/csv"),
    "activities": ("eqasim_activities.csv", "text/csv"),
    "network": ("output_network.xml.gz", "application/gzip"),
    "events": ("output_events.xml.gz", "application/gzip"),
    "transit_schedule": ("output_transitSchedule.xml.gz", "application/gzip"),
    "plans": ("output_plans.xml.gz", "application/gzip"),
}


class IngestFailed(RuntimeError):
    pass


class DatasetApi:
    def __init__(self, base_url: str, user_token: str, transport=None) -> None:
        self.base = base_url.rstrip("/")
        self.client = httpx.Client(timeout=TIMEOUT, transport=transport,
                                   cookies={"access_token": user_token})

    def close(self) -> None:
        self.client.close()

    # ── datasets ──
    def create_dataset(self, title: str, description: str) -> tuple[int, str]:
        name = title
        for attempt in range(5):
            r = self.client.post(f"{self.base}/datasets",
                                 json={"name": name,
                                       "description": description[:2000]})
            if r.status_code == 201:
                return r.json()["id"], name
            if r.status_code == 409:                 # name taken → suffix
                name = f"{title} ({attempt + 2})"
                continue
            raise RuntimeError(f"dataset create failed ({r.status_code}): "
                               f"{r.text[:300]}")
        raise RuntimeError("dataset create failed: name conflicts")

    def delete_dataset(self, ds_id: int) -> None:
        try:
            self.client.delete(f"{self.base}/datasets/{ds_id}")
        except httpx.HTTPError:
            pass

    def upload_duckdb(self, ds_id: int, category: str, path: Path) -> None:
        with open(path, "rb") as f:
            r = self.client.post(
                f"{self.base}/datasets/{ds_id}/upload/{category}",
                files={"file": (f"{category}.duckdb", f,
                                "application/octet-stream")})
        if r.status_code >= 300:
            raise RuntimeError(f"upload {category} failed ({r.status_code}): "
                               f"{r.text[:300]}")

    # ── ingest ──
    def start_ingest(self, ds_id: int, files: dict[str, Path],
                     run_name: str, sample_rate: float | None) -> None:
        handles = []
        parts = {}
        try:
            for field, (name, ctype) in _INGEST_PARTS.items():
                p = files.get(field)
                if p is None:
                    continue
                fh = open(p, "rb")
                handles.append(fh)
                parts[field] = (name, fh, ctype)
            for field in ("persons", "households"):
                p = files.get(field)
                if p is None:
                    continue
                fh = open(p, "rb")
                handles.append(fh)
                parts[field] = (p.name, fh, "application/octet-stream")
            data = {"run_name": run_name}
            if sample_rate:
                data["sample_rate"] = str(sample_rate)
            r = self.client.post(f"{self.base}/datasets/{ds_id}/ingest",
                                 data=data, files=parts)
        finally:
            for fh in handles:
                fh.close()
        if r.status_code >= 300:
            raise RuntimeError(f"ingest start failed ({r.status_code}): "
                               f"{r.text[:300]}")

    def ingest_status(self, ds_id: int) -> dict:
        r = self.client.get(f"{self.base}/datasets/{ds_id}/ingest/status")
        if r.status_code >= 300:
            raise RuntimeError(f"ingest status failed ({r.status_code}): "
                               f"{r.text[:300]}")
        return r.json()

    def wait_ingest(self, ds_id: int, on_progress=None, is_cancelled=None,
                    poll_seconds: float = 5.0) -> dict:
        """Block until the dataset's ingest job is done. Raises IngestFailed
        on a build error; returns the final job dict."""
        last = None
        while True:
            job = self.ingest_status(ds_id)
            state = job.get("state")
            if state == "done":
                return job
            if state == "error":
                raise IngestFailed(job.get("detail") or job.get("error")
                                   or "ingest failed")
            key = (job.get("step"), job.get("progress"))
            if key != last and on_progress:
                on_progress(float(job.get("progress") or 0),
                            str(job.get("step") or state or ""))
                last = key
            if is_cancelled and is_cancelled():
                raise RuntimeError("cancelled while ingesting")
            time.sleep(poll_seconds)

    def validate(self, ds_id: int) -> None:
        try:
            self.client.post(f"{self.base}/datasets/{ds_id}/validate")
        except httpx.HTTPError:
            pass


def result_description(description: str, lineage: dict) -> str:
    ops = "; ".join(lineage.get("summary") or [])
    params = lineage.get("params") or {}
    tail = (f"Custom simulation run on dataset #{lineage.get('base_dataset_id')}"
            f" - {ops}. {params.get('iterations', '?')} iterations.")
    return (f"{description.strip()}\n\n{tail}" if description.strip()
            else tail)[:2000]


def publish_result(api: DatasetApi, title: str, description: str,
                   lineage: dict, files: dict[str, Path],
                   microcensus_db: Path | None, run_name: str,
                   sample_rate: float | None, log=print,
                   on_ingest_progress=None, is_cancelled=None) -> int:
    """create dataset → (microcensus duckdb) → ingest raw outputs → wait.
    A dataset that failed to build is deleted again so the user is not left
    with a broken entry."""
    ds_id, name = api.create_dataset(title, result_description(description,
                                                               lineage))
    log(f"created dataset {ds_id} ('{name}')")
    try:
        if microcensus_db is not None and microcensus_db.exists():
            log(f"uploading microcensus ({microcensus_db.stat().st_size / 1e6:.0f} MB)")
            api.upload_duckdb(ds_id, "microcensus", microcensus_db)
        size = sum(p.stat().st_size for p in files.values()) / 1e6
        log(f"uploading {len(files)} raw output files ({size:.0f} MB) for ingest")
        api.start_ingest(ds_id, files, run_name, sample_rate)
        job = api.wait_ingest(ds_id, on_ingest_progress, is_cancelled)
        log(f"ingest done: {job.get('step') or ''}")
        api.validate(ds_id)
        return ds_id
    except Exception:
        log(f"publishing failed - removing incomplete dataset {ds_id}")
        api.delete_dataset(ds_id)
        raise

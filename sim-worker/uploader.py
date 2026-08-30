"""Upload the finished run as a dataset OF THE SUBMITTING USER.

Uses the public dataset API with the short-lived user token minted by the
broker — ownership, grants and quotas apply exactly as for a manual upload.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx

TIMEOUT = httpx.Timeout(60.0, read=600.0, write=3600.0)


def upload_result(dataset_api: str, user_token: str, title: str,
                  lineage: dict, synthetic_db: Path,
                  microcensus_db: Path | None, log=print) -> int:
    cookies = {"access_token": user_token}
    description = ("Custom simulation run. "
                   f"Base dataset: {lineage.get('base_dataset_id')}. "
                   f"Operations: {'; '.join(lineage.get('summary') or [])}. "
                   f"Params: {json.dumps(lineage.get('params') or {})}")[:2000]

    with httpx.Client(timeout=TIMEOUT) as client:
        name = title
        ds_id = None
        for attempt in range(5):
            r = client.post(f"{dataset_api}/datasets", cookies=cookies,
                            json={"name": name, "description": description})
            if r.status_code == 201:
                ds_id = r.json()["id"]
                break
            if r.status_code == 409:                 # name taken → suffix
                name = f"{title} ({attempt + 2})"
                continue
            raise RuntimeError(f"dataset create failed "
                               f"({r.status_code}): {r.text[:300]}")
        if ds_id is None:
            raise RuntimeError("dataset create failed: name conflicts")
        log(f"created dataset {ds_id} ('{name}')")

        for category, path in (("synthetic", synthetic_db),
                               ("microcensus", microcensus_db)):
            if path is None or not path.exists():
                log(f"{category}: no file - skipped")
                continue
            log(f"uploading {category} ({path.stat().st_size / 1e6:.0f} MB) ...")
            with open(path, "rb") as f:
                r = client.post(
                    f"{dataset_api}/datasets/{ds_id}/upload/{category}",
                    cookies=cookies,
                    files={"file": (f"{category}.duckdb", f,
                                    "application/octet-stream")})
            if r.status_code >= 300:
                raise RuntimeError(f"upload {category} failed "
                                   f"({r.status_code}): {r.text[:300]}")

        r = client.post(f"{dataset_api}/datasets/{ds_id}/validate",
                        cookies=cookies)
        if r.status_code >= 300:
            log(f"validate returned {r.status_code} (non-fatal)")
        return ds_id

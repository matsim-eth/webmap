from abc import ABC, abstractmethod
import logging
import os

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .paths import set_root_override

logger = logging.getLogger(__name__)

# ─── Dataset resolution ─────────────────────────────────────────────────

DATASET_SERVICE_URL = os.getenv("DATASET_SERVICE_URL", "http://dataset_backend:5033")

# In-process cache: (dataset_id, user_id) → root path
_resolve_cache: dict[tuple[int, int], str] = {}


async def _resolve_dataset_root(dataset_id: int, user_id: int, access_token: str) -> str:
    """Ask the dataset service for the filesystem root of *dataset_id*.

    Results are cached per (dataset_id, user_id) for the lifetime of the
    worker process, which is fine because paths never change once a dataset
    is created.
    """
    cache_key = (dataset_id, user_id)
    if cache_key in _resolve_cache:
        return _resolve_cache[cache_key]

    url = f"{DATASET_SERVICE_URL}/datasets/{dataset_id}/resolve"
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(
            url,
            cookies={"access_token": access_token},
        )
    if resp.status_code != 200:
        detail = resp.json().get("detail", resp.text) if resp.headers.get("content-type", "").startswith("application/json") else resp.text
        raise RuntimeError(f"Dataset resolve failed ({resp.status_code}): {detail}")

    root = resp.json()["root_path"]
    _resolve_cache[cache_key] = root
    return root


class DataProvider(ABC):
    """Base class for all JSON data endpoints.

    Subclasses must define:
      ROUTE: str  — the filename served, e.g. "age.json"
                    This becomes the URL /data/{dataset_id}/age.json
                    (prefix is set in main.py).

    The Python filename and class name are independent of ROUTE.
    """

    ROUTE: str

    @abstractmethod
    def deliver(self, params: dict) -> dict:
        """Compute and return the JSON-serialisable response dict.

        Args:
            params: Raw query parameters from the HTTP request (all values are strings).
        """
        ...


def mount_provider(app: FastAPI, provider: DataProvider, prefix: str = "/data") -> str:
    """Register a DataProvider as a GET endpoint on *app*.

    Route pattern: ``/data/{dataset_id}/age.json``

    The endpoint resolves the dataset's filesystem root via the dataset
    service and injects it as a per-request ContextVar override so that
    ``get_data_paths()`` returns the correct paths transparently.

    Returns the registered route path.
    """
    route = f"/{prefix.strip('/')}/{{dataset_id}}/{provider.ROUTE.lstrip('/')}"
    endpoint_name = f"data_{provider.ROUTE.replace('.', '_').replace('/', '_')}"

    @app.get(route, name=endpoint_name)
    async def _endpoint(dataset_id: int, request: Request):
        params = dict(request.query_params)

        # Lazy import to avoid circular deps at module level
        from main import OptionalUser  # noqa: E402

        try:
            user = await OptionalUser(request)
            user_id = int(user.get("sub") or user.get("id") or 0)
            access_token = request.cookies.get("access_token", "")
            root = await _resolve_dataset_root(dataset_id, user_id, access_token)
            set_root_override(root)
        except Exception as exc:
            logger.warning("dataset resolution failed: %s", exc)
            return JSONResponse({"error": f"Dataset resolution failed: {exc}"}, status_code=400)

        try:
            result = provider.deliver(params)
            if isinstance(result, JSONResponse):
                return result
            return JSONResponse(result)
        finally:
            set_root_override(None)

    return route

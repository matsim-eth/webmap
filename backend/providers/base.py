from abc import ABC, abstractmethod
from dataclasses import dataclass, field
import logging
import os
from typing import Any

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


@dataclass
class Param:
    """Describes a query parameter for OpenAPI documentation."""
    name: str
    description: str = ""
    default: Any = None
    enum: list[str] | None = None
    param_type: str = "string"  # "string", "integer", "number"
    required: bool = False


# Common filters reused across most providers
CANTON = Param("canton", "Filter by canton name or ID (comma-separated)")
SOURCE = Param("source", "Data source", enum=["synthetic", "microcensus"])
GENDER = Param("gender", "Gender filter (0=male, 1=female)", enum=["0", "1"])
AGE_MIN = Param("age_min", "Minimum age (inclusive)", param_type="integer")
AGE_MAX = Param("age_max", "Maximum age (exclusive)", param_type="integer")
MODE = Param("mode", "Transport mode filter (comma-separated)")
PURPOSE = Param("purpose", "Trip purpose filter (comma-separated)")

COMMON_FILTERS = [CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX, MODE, PURPOSE]
DEMO_FILTERS = [CANTON]
TRIP_FILTERS = [CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX, MODE, PURPOSE]
ACTIVITY_FILTERS = [CANTON, SOURCE, GENDER, AGE_MIN, AGE_MAX]


class DataProvider(ABC):
    """Base class for all JSON data endpoints.

    Subclasses must define:
      ROUTE: str   — the filename served, e.g. "age.json"
      PARAMS: list — query parameters for OpenAPI docs (default: empty)
    """

    ROUTE: str
    PARAMS: list[Param] = []

    @abstractmethod
    def deliver(self, params: dict) -> dict:
        """Compute and return the JSON-serialisable response dict.

        Args:
            params: Raw query parameters from the HTTP request (all values are strings).
        """
        ...


def _params_to_openapi(params: list[Param]) -> dict | None:
    """Convert a list of Param to an openapi_extra dict for FastAPI."""
    if not params:
        return None
    extra = []
    for p in params:
        schema: dict[str, Any] = {"type": p.param_type}
        if p.default is not None:
            schema["default"] = p.default
        if p.enum:
            schema["enum"] = p.enum
        extra.append({
            "name": p.name,
            "in": "query",
            "required": p.required,
            "description": p.description,
            "schema": schema,
        })
    return {"parameters": extra}


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
    openapi_extra = _params_to_openapi(provider.PARAMS)

    @app.get(route, name=endpoint_name, openapi_extra=openapi_extra)
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
            # Strip redundant "All" aggregate when a canton filter is active
            if params.get("canton") and isinstance(result, dict):
                result.pop("All", None)
            return JSONResponse(result)
        finally:
            set_root_override(None)

    return route

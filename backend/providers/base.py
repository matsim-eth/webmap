from abc import ABC, abstractmethod

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class DataProvider(ABC):
    """Base class for all JSON data endpoints.

    Subclasses must define:
      ROUTE: str  — the filename served, e.g. "age.json"
                    This becomes the URL /data/age.json (prefix is set in main.py).

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

    Returns the registered route path.
    """
    route = f"/{prefix.strip('/')}/{provider.ROUTE.lstrip('/')}"

    @app.get(route)
    async def _endpoint(request: Request):
        result = provider.deliver(dict(request.query_params))
        if isinstance(result, JSONResponse):
            return result
        return JSONResponse(result)

    return route

import os

ROOT_DIRECTORY = os.environ.get("WEBMAP_ROOT_DIRECTORY") or os.environ.get("WEBMAP_ROOT_DIR") or os.getcwd()

from fastapi import Request
from fastapi.responses import JSONResponse


class FileProvider:
    FILE = None

    def deliver(self, flt):
        raise NotImplementedError


def mount_provider(app, provider, prefix=""):
    route = "/" + provider.FILE.lstrip("/")
    if prefix:
        route = "/" + prefix.strip("/") + route

    @app.get(route)
    async def _endpoint(request: Request):
        flt = dict(request.query_params)
        out = provider.deliver(flt)
        if isinstance(out, JSONResponse):
            return out
        return JSONResponse(out)

    return route




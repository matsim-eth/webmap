# main.py

import os
import sys
from pathlib import Path

from jsonprovider.gender import gender
from jsonprovider.departure_times import departure_times
from jsonprovider.car_availability import car_availability
from jsonprovider.num_cars_age import num_cars_age
from jsonprovider.num_cars_gender import num_cars_gender
from jsonprovider.num_cars_income import num_cars_income
from jsonprovider.pt_subscriptions import pt_subscriptions
from jsonprovider.pt_sub_age import pt_sub_age
from jsonprovider.pt_sub_gender import pt_sub_gender
from jsonprovider.pt_sub_income import pt_sub_income
BACKEND_DIR = Path(__file__).resolve().parent
WEBMAP_DIR = BACKEND_DIR.parent
PROJECT_ROOT = WEBMAP_DIR.parent

sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(PROJECT_ROOT))

from jsonprovider.DataProvider import mount_provider
from jsonprovider.age import age
from jsonprovider.pt_link_volumes_link_line_Glarus import pt_link_volumes_link_line_Glarus

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from AuthAPI import User, create_refresh_token, token_hash, RefreshToken, get_db, create_access_token, decode_token, \
    verify_password, hash_password, Base, RequireUser
from fastapi import FastAPI, Request, Response, status, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware

from starlette.middleware.trustedhost import TrustedHostMiddleware

os.environ["WEBMAP_ROOT"] = "./dummy_data/webmap_data/"

LOCAL_RUN = (os.getenv("LOCAL_RUN", "0").strip().lower() in {"1", "true"})

def LocalUser():
    return {"username": "local"}




async def OptionalUser(request: Request):
    if LOCAL_RUN:
        return LocalUser()
    u = RequireUser(request)
    if hasattr(u, "__await__"):
        u = await u
    return u


APP_NAME = os.getenv("APP_NAME", "backend")
ENV = os.getenv("ENV", "dev")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

ALLOWED_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
TRUSTED_HOSTS = [h.strip() for h in os.getenv("TRUSTED_HOSTS", "").split(",") if h.strip()]

COOKIE_SECURE = os.getenv("COOKIE_SECURE", "1" if ENV == "prod" else "0") == "1"
COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "lax")
ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")
REFRESH_COOKIE_NAME = os.getenv("REFRESH_COOKIE_NAME", "refresh_token")

docs_url = None if ENV == "prod" else "/docs"
redoc_url = None if ENV == "prod" else "/redoc"
openapi_url = None if ENV == "prod" else "/openapi.json"

logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(APP_NAME)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(
    title=APP_NAME,
    lifespan=lifespan,
    docs_url=docs_url,
    redoc_url=redoc_url,
    openapi_url=openapi_url,
)

#mount_provider(app, pt_link_volumes_link_line_Glarus(), prefix="/data")
mount_provider(app, age(), prefix="/data")
mount_provider(app, gender(), prefix="/data")
mount_provider(app, departure_times(), prefix="/data")
mount_provider(app, car_availability(), prefix="/data")
mount_provider(app, num_cars_age(), prefix="/data")
mount_provider(app, num_cars_gender(), prefix="/data")
mount_provider(app, num_cars_income(), prefix="/data")
mount_provider(app, pt_subscriptions(), prefix="/data")
mount_provider(app, pt_sub_age(), prefix="/data")
mount_provider(app, pt_sub_gender(), prefix="/data")
mount_provider(app, pt_sub_income(), prefix="/data")


if TRUSTED_HOSTS:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=TRUSTED_HOSTS)

app.add_middleware(GZipMiddleware, minimum_size=1000)

if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Location", "Set-Cookie"],
    )


class ErrorOut(BaseModel):
    detail: str


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("unhandled_error")
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal Server Error"},
    )


def _ttl_seconds_from_exp(exp: int | None) -> int | None:
    if not exp:
        return None
    now = int(datetime.now(timezone.utc).timestamp())
    ttl = int(exp) - now
    return ttl if ttl > 0 else 0



@app.get("/health", response_model=dict)
async def health(user = Depends(OptionalUser)):
    return {"status": "ok", "local_run": LOCAL_RUN, "name": user.get("username")}

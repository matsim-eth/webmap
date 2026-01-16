# main.py

import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request, Depends, HTTPException, status, Response, Header, Cookie
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.Authentification import RequireUser, RequireAdminUser
from api.security import (
    hash_password,
    verify_password,
    create_refresh_token,
    create_access_token,
    token_hash,
    decode_token,
)
from schemas import (
    RegisterCredentialsModel,
    TokenOut,
    LoginModel,
    RefreshIn,
)
from api.db_models import User, RefreshToken
from api.db import engine, get_db, Base


APP_NAME = os.getenv("APP_NAME", "auth-api")
ENV = os.getenv("ENV", "dev")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

ALLOWED_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
TRUSTED_HOSTS = [h.strip() for h in os.getenv("TRUSTED_HOSTS", "").split(",") if h.strip()]

COOKIE_SECURE = os.getenv("COOKIE_SECURE", "1" if ENV == "prod" else "0") == "1"
COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "lax")  # lax/strict/none
ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")
REFRESH_COOKIE_NAME = os.getenv("REFRESH_COOKIE_NAME", "refresh_token")

logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(APP_NAME)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("DB_CREATE_TABLES", "0") == "1":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


docs_url = None if ENV == "prod" else "/docs"
redoc_url = None if ENV == "prod" else "/redoc"
openapi_url = None if ENV == "prod" else "/openapi.json"

app = FastAPI(
    title=APP_NAME,
    lifespan=lifespan,
    docs_url=docs_url,
    redoc_url=redoc_url,
    openapi_url=openapi_url,
)

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


def _ttl_seconds(token: str) -> int | None:
    try:
        dec = decode_token(token)
        exp = dec.get("exp")
        if not exp:
            return None
        now = int(datetime.now(timezone.utc).timestamp())
        ttl = int(exp) - now
        return ttl if ttl > 0 else 0
    except Exception:
        return None


def _set_auth_cookies(resp: Response, access: str, refresh: str) -> None:
    access_ttl = _ttl_seconds(access)
    refresh_ttl = _ttl_seconds(refresh)

    resp.set_cookie(
        key=ACCESS_COOKIE_NAME,
        value=access,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        path="/",
        max_age=access_ttl,
    )
    resp.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=refresh,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        path="/",
        max_age=refresh_ttl,
    )


def _clear_auth_cookies(resp: Response) -> None:
    resp.delete_cookie(key=ACCESS_COOKIE_NAME, path="/")
    resp.delete_cookie(key=REFRESH_COOKIE_NAME, path="/")


def _looks_like_email(s: str) -> bool:
    s = (s or "").strip()
    return ("@" in s) and ("." in s)


@app.get("/health", response_model=dict)
async def health():
    return {"status": "ok", "env": ENV}


@app.post("/register", response_model=dict)
async def register(credentials: RegisterCredentialsModel, db: AsyncSession = Depends(get_db)):
    email = str(credentials.email).lower()

    existing = await db.scalar(select(User).where(User.email == email))
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already registered")

    if credentials.username:
        u = await db.scalar(select(User).where(User.username == credentials.username))
        if u:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="username already taken")

    user = User(
        email=email,
        hashed_password=hash_password(credentials.password),
        first_name=credentials.first_name,
        last_name=credentials.last_name,
        username=credentials.username,
        company=credentials.company,
        newsletter=bool(credentials.newsletter),
        is_active=True,
        admin=False,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return {"id": user.id, "email": user.email}


@app.post("/login", response_model=TokenOut)
async def login(data: LoginModel, response: Response, db: AsyncSession = Depends(get_db)):
    email = data.email
    username = data.username
    identifier = (data.identifier or "").strip()

    # bevorzugt email, wenn beides vorhanden
    login_email = str(email).lower().strip() if email else ""
    login_username = (username or "").strip()

    if not login_email and not login_username and identifier:
        if _looks_like_email(identifier):
            login_email = identifier.lower()
        else:
            login_username = identifier

    user = None
    if login_email:
        user = await db.scalar(select(User).where(User.email == login_email))
    elif login_username:
        user = await db.scalar(select(User).where(User.username == login_username))

    if not user or not user.is_active or not verify_password(data.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    access = create_access_token(user)
    refresh, jti, exp = create_refresh_token(user)

    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=token_hash(refresh),
            jti=jti,
            expires_at=exp,
            revoked=False,
            replaced_by_jti=None,
        )
    )
    await db.commit()

    _set_auth_cookies(response, access, refresh)
    return TokenOut(access_token=access, refresh_token=refresh)


@app.post("/refresh", response_model=TokenOut)
async def refresh_access_token(
    payload: RefreshIn,
    response: Response,
    x_refresh_token: str | None = Header(None, alias="X-Refresh-Token"),
    refresh_cookie: str | None = Cookie(None, alias=REFRESH_COOKIE_NAME),
    db: AsyncSession = Depends(get_db),
):
    refresh_token = (x_refresh_token or "").strip() or (payload.refresh_token or "").strip() or (refresh_cookie or "").strip()
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid refresh token")

    try:
        decoded = decode_token(refresh_token)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid refresh token")

    if decoded.get("typ") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid refresh token")

    sub = decoded.get("sub")
    jti = decoded.get("jti")
    if not sub or not jti:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid refresh token")

    now = datetime.now(timezone.utc)
    rt = await db.scalar(select(RefreshToken).where(RefreshToken.jti == jti))
    if not rt or rt.revoked or rt.expires_at <= now:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid refresh token")

    user = await db.scalar(select(User).where(User.id == int(sub)))
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid refresh token")

    new_access = create_access_token(user)
    new_refresh, new_jti, new_exp = create_refresh_token(user)

    await db.execute(
        update(RefreshToken).where(RefreshToken.id == rt.id).values(revoked=True, replaced_by_jti=new_jti)
    )
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=token_hash(new_refresh),
            jti=new_jti,
            expires_at=new_exp,
            revoked=False,
            replaced_by_jti=None,
        )
    )
    await db.commit()

    _set_auth_cookies(response, new_access, new_refresh)
    return TokenOut(access_token=new_access, refresh_token=new_refresh)


@app.get("/me", response_model=dict)
async def me(user: User = Depends(RequireUser())):
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "admin": user.admin,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "is_active": user.is_active,
        "company": getattr(user, "company", None),
        "newsletter": getattr(user, "newsletter", False),
    }


@app.post("/logout", response_model=dict)
async def logout(
    response: Response,
    payload: RefreshIn,
    refresh_cookie: str | None = Cookie(None, alias=REFRESH_COOKIE_NAME),
    x_refresh_token: str | None = Header(None, alias="X-Refresh-Token"),
    db: AsyncSession = Depends(get_db),
):
    refresh_token = (x_refresh_token or "").strip() or (payload.refresh_token or "").strip() or (refresh_cookie or "").strip()

    if refresh_token:
        try:
            decoded = decode_token(refresh_token)
            if decoded.get("typ") == "refresh":
                jti = decoded.get("jti")
                if jti:
                    await db.execute(update(RefreshToken).where(RefreshToken.jti == jti).values(revoked=True))
                    await db.commit()
        except Exception:
            pass

    _clear_auth_cookies(response)
    return {"ok": True}
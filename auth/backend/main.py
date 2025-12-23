import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request, Depends, HTTPException, status, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from auth.api.Authentification import (
    RequireAuth,
    RequireAdmin,
    RequireUser,
)
from auth.api.security import (
    hash_password,
    verify_password,
    create_refresh_token,
    create_access_token,
    token_hash,
    decode_token,
)
from auth.backend.schemas import (
    AccessIn,
    RegisterCredentialsModel,
    TokenOut,
    LoginModel,
    RefreshIn,
)
from auth.api.db_models import User, RefreshToken
from auth.api.db import engine, get_db, Base


# -----------------------------------------------------------------------------
# Configuration / Logging
# -----------------------------------------------------------------------------

APP_NAME = os.getenv("APP_NAME", "auth-api")
ENV = os.getenv("ENV", "dev")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()
]
TRUSTED_HOSTS = [
    h.strip() for h in os.getenv("TRUSTED_HOSTS", "").split(",") if h.strip()
]

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(APP_NAME)


# -----------------------------------------------------------------------------
# Lifespan (Startup / Shutdown)
# -----------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup:
      - optional: Create Datatables, if DB_CREATE_TABLES=1
    Shutdown:
      - DB-Engine sauber schließen
    """
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


# -----------------------------------------------------------------------------
# Middleware
# -----------------------------------------------------------------------------

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
        expose_headers=["Location"],

    )


# -----------------------------------------------------------------------------
# Error Handling
# -----------------------------------------------------------------------------

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


# -----------------------------------------------------------------------------
# Health
# -----------------------------------------------------------------------------

@app.get("/health", response_model=dict)
async def health():
    return {"status": "ok", "env": ENV}


# -----------------------------------------------------------------------------
# Registrierung / Login / Token-Refresh
# -----------------------------------------------------------------------------

@app.post("/register", response_model=dict)
async def register(
    credentials: RegisterCredentialsModel,
    db: AsyncSession = Depends(get_db),
):
    email = str(credentials.email).lower()

    existing = await db.scalar(select(User).where(User.email == email))
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="email already registered",
        )

    if credentials.username:
        u = await db.scalar(select(User).where(User.username == credentials.username))
        if u:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="username already taken",
            )

    user = User(
        email=email,
        hashed_password=hash_password(credentials.password),
        first_name=credentials.first_name,
        last_name=credentials.last_name,
        username=credentials.username,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return {"id": user.id, "email": user.email}


@app.post("/login", response_model=TokenOut)
async def login(
    data: LoginModel,
    db: AsyncSession = Depends(get_db),
):
    email = str(data.email).lower()
    user = await db.scalar(select(User).where(User.email == email))

    if not user or not user.is_active or not verify_password(
        data.password,
        user.hashed_password,
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid credentials",
        )

    access = create_access_token(user)
    refresh, jti, exp = create_refresh_token(user)

    rt = RefreshToken(
        user_id=user.id,
        token_hash=token_hash(refresh),
        jti=jti,
        expires_at=exp,
        revoked=False,
        replaced_by_jti=None,
    )
    db.add(rt)
    await db.commit()

    return TokenOut(access_token=access, refresh_token=refresh)


@app.post("/refresh", response_model=TokenOut)
async def refresh_access_token(
    payload: RefreshIn,
    db: AsyncSession = Depends(get_db),
):
    try:
        decoded = decode_token(payload.refresh_token)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid refresh token",
        )

    if decoded.get("typ") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid refresh token",
        )

    sub = decoded.get("sub")
    jti = decoded.get("jti")
    if not sub or not jti:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid refresh token",
        )

    now = datetime.now(timezone.utc)
    rt = await db.scalar(select(RefreshToken).where(RefreshToken.jti == jti))

    if not rt or rt.revoked or rt.expires_at <= now:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid refresh token",
        )

    user = await db.scalar(select(User).where(User.id == int(sub)))
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid refresh token",
        )

    new_access = create_access_token(user)
    new_refresh, new_jti, new_exp = create_refresh_token(user)

    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.id == rt.id)
        .values(revoked=True, replaced_by_jti=new_jti)
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

    return TokenOut(access_token=new_access, refresh_token=new_refresh)


# -----------------------------------------------------------------------------
# Token-Validierung – nur "ok" (200) zurück
# -----------------------------------------------------------------------------

@app.post("/validate/refresh_token")
async def validate_refresh_token(
    payload: RefreshIn,
    db: AsyncSession = Depends(get_db),
) -> Response:
    try:
        decoded = decode_token(payload.refresh_token)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid refresh token",
        )

    if decoded.get("typ") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid refresh token",
        )

    sub = decoded.get("sub")
    jti = decoded.get("jti")
    if not sub or not jti:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid refresh token",
        )

    now = datetime.now(timezone.utc)
    rt = await db.scalar(select(RefreshToken).where(RefreshToken.jti == jti))
    if not rt or rt.revoked or rt.expires_at <= now:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="refresh expired",
        )

    return Response(content="ok", media_type="text/plain", status_code=status.HTTP_200_OK)


@app.post("/validate/access_token")
async def validate_access_token(
    payload: AccessIn,
) -> Response:
    try:
        decoded = decode_token(payload.access_token)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid access token",
        )

    if decoded.get("typ") != "access":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid access token",
        )

    exp = decoded.get("exp")
    if isinstance(exp, (int, float)):
        exp_dt = datetime.fromtimestamp(exp, tz=timezone.utc)
        now = datetime.now(timezone.utc)
        if exp_dt <= now:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="access token expired",
            )

    return Response(content="ok", media_type="text/plain", status_code=status.HTTP_200_OK)


# -----------------------------------------------------------------------------
# User-Info
# -----------------------------------------------------------------------------
@app.get("/test")
@RequireAuth
async def test() -> Response:
    return Response(content="ok", media_type="text/plain", status_code=status.HTTP_200_OK)
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
    }


# -----------------------------------------------------------------------------
# Logout
# -----------------------------------------------------------------------------

@app.post("/logout", response_model=dict)
@RequireAuth
async def logout(
    payload: RefreshIn,
    auth_token: str,
    db: AsyncSession = Depends(get_db),
):
    try:
        decoded = decode_token(payload.refresh_token)
    except Exception:
        return {"ok": True}

    if decoded.get("typ") != "refresh":
        return {"ok": True}

    jti = decoded.get("jti")
    if not jti:
        return {"ok": True}

    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.jti == jti)
        .values(revoked=True)
    )
    await db.commit()

    return {"ok": True}
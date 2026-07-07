# main.py

import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import AuthAPI
from AuthAPI import API
from AuthAPI import (
    User, create_refresh_token, token_hash, RefreshToken, get_db,
    create_access_token, decode_token, verify_password, hash_password,
    Base, RequireUser, RequireAdminUser,
)
from fastapi import FastAPI, Request, Depends, HTTPException, status, Response, Header, Cookie
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse
from pydantic import BaseModel



from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from schemas import (
    RegisterCredentialsModel,
    TokenOut,
    LoginModel,
    RefreshIn,
    AdminUserUpdate,
    ResendVerificationIn,
)



API.init(
    secret_key=os.getenv("JWT_SECRET", "UltraSecretKey"),
    algorithm=os.getenv("JWT_ALG", "HS256"),
    access_minutes=int(os.getenv("ACCESS_TOKEN_MINUTES", "15")),
    refresh_days=int(os.getenv("REFRESH_TOKEN_DAYS", "14")),
    bcrypt_rounds=int(os.getenv("BCRYPT_ROUNDS", "12")),
    access_cookie_name=os.getenv("ACCESS_COOKIE_NAME", "access_token"),
    use_db=True,
    database_url=os.getenv("DATABASE_URL", "postgresql+asyncpg://user:pass@auth_db:5432/appdb"),
)



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

DEV_MODE = os.getenv("DEV_MODE", "0").strip().lower() in {"1", "true"}

# ── Registration gates (both optional, both default OFF) ─────────
# REQUIRE_EMAIL_VERIFICATION=1 → new accounts must click a mailed link
#   before they can log in. Without SMTP config the link is logged instead
#   of mailed (dev fallback), so the flow stays testable locally.
# REQUIRE_ADMIN_APPROVAL=1 → new accounts start unapproved; an admin must
#   activate them in the admin panel before first login.
REQUIRE_EMAIL_VERIFICATION = os.getenv("REQUIRE_EMAIL_VERIFICATION", "0").strip().lower() in {"1", "true"}
REQUIRE_ADMIN_APPROVAL = os.getenv("REQUIRE_ADMIN_APPROVAL", "0").strip().lower() in {"1", "true"}
VERIFY_TOKEN_HOURS = int(os.getenv("VERIFY_TOKEN_HOURS", "48"))

# Base URL used to build the verification link (the proxy origin).
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost").rstrip("/")

# SMTP — all empty by default; the mailer falls back to logging the link.
SMTP_HOST = os.getenv("SMTP_HOST", "").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "").strip()
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USER or "webmap@localhost")
SMTP_STARTTLS = os.getenv("SMTP_STARTTLS", "1").strip().lower() in {"1", "true"}

# ── Default accounts (from .env) ──────────────────────────────
SYSTEM_ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@webmap.local")
SYSTEM_ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
DEV_EMAIL = os.getenv("DEV_EMAIL", "dev@local")
DEV_PASSWORD = os.getenv("DEV_PASSWORD", "dev")
DATASET_SERVICE_URL = os.getenv("DATASET_SERVICE_URL", "http://dataset_backend:5033")

# Shared secret sent to the dataset service's unauthenticated /internal/*
# endpoints (init/delete user storage). Must match INTERNAL_SERVICE_SECRET in
# the dataset service. Empty → header omitted (dataset service then relies on
# proxy/network isolation only).
INTERNAL_SERVICE_SECRET = os.getenv("INTERNAL_SERVICE_SECRET", "").strip()


def _internal_headers() -> dict:
    return {"X-Internal-Secret": INTERNAL_SERVICE_SECRET} if INTERNAL_SERVICE_SECRET else {}


async def _seed_one(
    db: AsyncSession,
    *,
    email: str,
    password: str,
    username: str,
    first_name: str,
    last_name: str,
    company: str,
    is_admin: bool = True,
    is_dev: bool = False,
):
    """Create or update a seeded user by email. Handles username conflicts."""
    from sqlalchemy.exc import IntegrityError

    user = await db.scalar(select(User).where(User.email == email))
    if user:
        user.hashed_password = hash_password(password)
        user.admin = is_admin
        user.is_active = True
        await db.commit()
        # Set dev flag via raw SQL (column not in ORM model)
        await db.execute(
            text("UPDATE users SET dev = :dev, email_verified = TRUE, approved = TRUE WHERE email = :email"),
            {"dev": is_dev, "email": email},
        )
        await db.commit()
        logger.info("Refreshed seeded user: %s (admin=%s, dev=%s)", email, is_admin, is_dev)
        return

    # Check if target username is already taken by another account
    clash = await db.scalar(select(User).where(User.username == username))
    if clash:
        # Username taken — append suffix to avoid conflict
        username = f"{username}_{email.split('@')[0]}"
        logger.warning("Username conflict — using '%s' instead", username)

    user = User(
        email=email,
        hashed_password=hash_password(password),
        first_name=first_name,
        last_name=last_name,
        username=username,
        company=company,
        is_active=True,
        admin=is_admin,
        newsletter=False,
    )
    db.add(user)
    try:
        await db.commit()
        # Set dev flag via raw SQL
        await db.execute(
            text("UPDATE users SET dev = :dev, email_verified = TRUE, approved = TRUE WHERE email = :email"),
            {"dev": is_dev, "email": email},
        )
        await db.commit()
        logger.info("Created seeded user: %s (admin=%s, dev=%s)", email, is_admin, is_dev)
    except IntegrityError:
        await db.rollback()
        logger.error("Could not seed user %s (duplicate key)", email)


# ── Mailer ────────────────────────────────────────────────────────


def _smtp_send(to: str, subject: str, html: str) -> None:
    """Blocking SMTP send — run via asyncio.to_thread. Raises on failure."""
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = to
    msg.attach(MIMEText(html, "html"))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
        if SMTP_STARTTLS:
            s.starttls()
        if SMTP_USER:
            s.login(SMTP_USER, SMTP_PASSWORD)
        s.sendmail(SMTP_FROM, [to], msg.as_string())


async def _send_verification_email(email: str, first_name: str, token: str) -> None:
    """Mail the verification link; without SMTP config, log it (dev fallback).
    Never raises — a mail hiccup must not fail the registration itself."""
    import asyncio

    link = f"{PUBLIC_BASE_URL}/authentification/backend/verify-email?token={token}"
    if not SMTP_HOST:
        logger.warning("SMTP not configured — verification link for %s: %s", email, link)
        return
    html = f"""
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#4f46e5">Webmap - confirm your email</h2>
      <p>Hi {first_name or "there"},</p>
      <p>please confirm your email address to activate your Webmap account:</p>
      <p style="margin:24px 0">
        <a href="{link}" style="background:#4f46e5;color:#fff;padding:12px 24px;
           border-radius:8px;text-decoration:none;display:inline-block">Verify email</a>
      </p>
      <p style="color:#666;font-size:13px">The link is valid for {VERIFY_TOKEN_HOURS} hours.
        If you didn't create this account you can ignore this email.</p>
    </div>
    """
    try:
        await asyncio.to_thread(_smtp_send, email, "Webmap - verify your email", html)
        logger.info("Verification email sent to %s", email)
    except Exception:
        logger.exception("Verification email to %s failed — link: %s", email, link)


async def _init_user_storage(user_id: int):
    """Call dataset backend to create per-user storage directory (best-effort)."""
    import httpx
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{DATASET_SERVICE_URL}/internal/init-user/{user_id}",
                                     headers=_internal_headers(), timeout=5.0)
            resp.raise_for_status()
        logger.info("Init storage for user %s", user_id)
    except Exception:
        logger.warning("Could not init storage for user %s (dataset service may not be ready)", user_id)


async def _seed_default_users():
    """Create or update system admin (always) and dev user (DEV_MODE only)."""
    async for db in get_db():
        if SYSTEM_ADMIN_PASSWORD:
            await _seed_one(
                db,
                email=SYSTEM_ADMIN_EMAIL,
                password=SYSTEM_ADMIN_PASSWORD,
                username="admin",
                first_name="System",
                last_name="Admin",
                company="System",
                is_admin=True,
                is_dev=False,
            )

        else:
            logger.warning("ADMIN_PASSWORD not set — skipping admin seed")

        if DEV_MODE:
            await _seed_one(
                db,
                email=DEV_EMAIL,
                password=DEV_PASSWORD,
                username="dev",
                first_name="Dev",
                last_name="User",
                company="Development",
                is_admin=True,
                is_dev=True,
            )

        # Create storage folders for ALL existing users
        all_users = (await db.scalars(select(User))).all()
        for u in all_users:
            await _init_user_storage(u.id)

        break  # get_db yields one session


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("DB_CREATE_TABLES", "0") == "1":
        await AuthAPI.create_tables()
    # Add columns the ORM doesn't know about (same pattern as `dev`).
    # email_verified/approved default TRUE so every EXISTING account keeps
    # working when the gates are switched on later.
    from AuthAPI import get_engine
    async with get_engine().begin() as conn:
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS dev BOOLEAN DEFAULT FALSE"))
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT TRUE"))
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT TRUE"))
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT"))
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_expires TIMESTAMPTZ"))
    await _seed_default_users()
    yield
    await AuthAPI.close()


docs_url = None if ENV == "prod" else "/docs"
redoc_url = None if ENV == "prod" else "/redoc"
openapi_url = None if ENV == "prod" else "/openapi.json"

app = FastAPI(
    title=APP_NAME,
    lifespan=lifespan,
    docs_url=docs_url,
    redoc_url=redoc_url,
    openapi_url=openapi_url,
    root_path=os.getenv("ROOT_PATH", ""),
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
    return "@" in s


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

    # Registration gates: email verification and/or admin approval.
    verify_token = None
    if REQUIRE_EMAIL_VERIFICATION or REQUIRE_ADMIN_APPROVAL:
        import secrets
        from datetime import timedelta
        verify_token = secrets.token_urlsafe(32) if REQUIRE_EMAIL_VERIFICATION else None
        await db.execute(
            text("""UPDATE users SET
                        email_verified = :verified,
                        approved = :approved,
                        verify_token = :tok,
                        verify_token_expires = :exp
                    WHERE id = :id"""),
            {
                "verified": not REQUIRE_EMAIL_VERIFICATION,
                "approved": not REQUIRE_ADMIN_APPROVAL,
                "tok": verify_token,
                "exp": (datetime.now(timezone.utc) + timedelta(hours=VERIFY_TOKEN_HOURS))
                       if verify_token else None,
                "id": user.id,
            },
        )
        await db.commit()
    if verify_token:
        await _send_verification_email(email, credentials.first_name, verify_token)

    # Create per-user storage directory via dataset backend (best-effort)
    await _init_user_storage(user.id)

    return {
        "id": user.id,
        "email": user.email,
        "verification_required": REQUIRE_EMAIL_VERIFICATION,
        "approval_required": REQUIRE_ADMIN_APPROVAL,
    }


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
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    # Dev-account gate: dev users can only log in when DEV_MODE is enabled
    is_dev_user = await db.scalar(text("SELECT dev FROM users WHERE id = :id"), {"id": user.id})
    if is_dev_user and not DEV_MODE:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="dev login disabled")

    # Registration gates. 403 (not 401) so the frontend can distinguish
    # "wrong credentials" from "account exists but is not unlocked yet".
    # Checked even when the flags are currently off, so accounts created
    # while a gate was active stay gated until resolved.
    flags = (await db.execute(
        text("SELECT email_verified, approved FROM users WHERE id = :id"), {"id": user.id}
    )).one()
    if flags.email_verified is False:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="email not verified - check your inbox")
    if flags.approved is False:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="account pending admin approval")

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


def _verify_page(title: str, message: str, ok: bool) -> HTMLResponse:
    color = "#16a34a" if ok else "#dc2626"
    icon = "✓" if ok else "✕"
    return HTMLResponse(f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} - Webmap</title>
<style>
  body {{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:system-ui,-apple-system,sans-serif;
         background:linear-gradient(135deg,#eef2ff 0%,#faf5ff 100%); }}
  .card {{ background:#fff; border-radius:16px; padding:48px 40px; max-width:420px; text-align:center;
          box-shadow:0 10px 40px rgba(79,70,229,.12); }}
  .icon {{ width:64px; height:64px; border-radius:50%; display:flex; align-items:center; justify-content:center;
          margin:0 auto 20px; font-size:30px; color:#fff; background:{color}; }}
  h1 {{ font-size:22px; margin:0 0 10px; color:#1e1b4b; }}
  p {{ color:#64748b; line-height:1.55; margin:0 0 26px; }}
  a {{ background:#4f46e5; color:#fff; padding:12px 28px; border-radius:10px; text-decoration:none;
      font-weight:600; display:inline-block; }}
  a:hover {{ background:#4338ca; }}
</style></head>
<body><div class="card"><div class="icon">{icon}</div><h1>{title}</h1><p>{message}</p>
<a href="/authentification/">Go to login</a></div></body></html>""")


@app.get("/verify-email")
async def verify_email(token: str = "", db: AsyncSession = Depends(get_db)):
    """Landing endpoint of the mailed verification link. Returns HTML."""
    token = (token or "").strip()
    if not token:
        return _verify_page("Invalid link", "This verification link is malformed.", ok=False)

    row = (await db.execute(
        text("SELECT id, email_verified, verify_token_expires FROM users WHERE verify_token = :tok"),
        {"tok": token},
    )).first()
    if not row:
        return _verify_page("Invalid link", "This verification link is unknown or was already used.", ok=False)
    if row.verify_token_expires and row.verify_token_expires < datetime.now(timezone.utc):
        return _verify_page("Link expired",
                            "This link is no longer valid. Log in to request a new one.", ok=False)

    await db.execute(
        text("""UPDATE users SET email_verified = TRUE, verify_token = NULL,
                       verify_token_expires = NULL WHERE id = :id"""),
        {"id": row.id},
    )
    await db.commit()

    if REQUIRE_ADMIN_APPROVAL:
        approved = await db.scalar(text("SELECT approved FROM users WHERE id = :id"), {"id": row.id})
        if not approved:
            return _verify_page("Email verified",
                                "Your email is confirmed. An administrator still needs to approve "
                                "your account — you will be able to log in once that happens.", ok=True)
    return _verify_page("Email verified", "Your account is active — you can log in now.", ok=True)


@app.post("/resend-verification", response_model=dict)
async def resend_verification(payload: ResendVerificationIn, db: AsyncSession = Depends(get_db)):
    """Re-send the verification email. Always returns ok (no account enumeration)."""
    email = str(payload.email or "").lower().strip()
    if email:
        row = (await db.execute(
            text("SELECT id, first_name, email_verified FROM users WHERE email = :e"), {"e": email}
        )).first()
        if row and row.email_verified is False:
            import secrets
            from datetime import timedelta
            tok = secrets.token_urlsafe(32)
            await db.execute(
                text("UPDATE users SET verify_token = :tok, verify_token_expires = :exp WHERE id = :id"),
                {"tok": tok,
                 "exp": datetime.now(timezone.utc) + timedelta(hours=VERIFY_TOKEN_HOURS),
                 "id": row.id},
            )
            await db.commit()
            await _send_verification_email(email, row.first_name, tok)
    return {"ok": True}


@app.get("/me", response_model=dict)
async def me(user: User = Depends(RequireUser(data=True)), db: AsyncSession = Depends(get_db)):
    is_dev = await db.scalar(text("SELECT dev FROM users WHERE id = :id"), {"id": user.id})
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "admin": user.admin,
        "dev": bool(is_dev),
        "first_name": user.first_name,
        "last_name": user.last_name,
        "is_active": user.is_active,
        "company": getattr(user, "company", None),
        "newsletter": getattr(user, "newsletter", False),
    }


@app.api_route("/logout", methods=["GET", "POST"], response_model=dict)
async def logout(
    response: Response,
    payload: RefreshIn | None = None,
    refresh_cookie: str | None = Cookie(None, alias=REFRESH_COOKIE_NAME),
    x_refresh_token: str | None = Header(None, alias="X-Refresh-Token"),
    db: AsyncSession = Depends(get_db),
):
    refresh_token = (x_refresh_token or "").strip() or (((payload.refresh_token if payload else "") or "").strip()) or (refresh_cookie or "").strip()
    if refresh_token:
        try:
            decoded = decode_token(refresh_token)
            if decoded.get("typ") == "refresh":
                jti = decoded.get("jti")
                if jti:
                    await db.execute(update(RefreshToken).where(RefreshToken.jti == jti).values(revoked=True))
                    await db.commit()
        except Exception:
            return {"ok": False}

    _clear_auth_cookies(response)
    return {"ok": True}


# ── Admin endpoints ─────────────────────────────────────────────


@app.get("/admin/users", response_model=dict)
async def admin_list_users(
    admin: User = Depends(RequireAdminUser(data=True)),
    db: AsyncSession = Depends(get_db),
):
    """List all users. Admin only."""
    users = (await db.scalars(select(User).order_by(User.created_at.desc()))).all()
    # Fetch extra flags via raw SQL (columns not in the ORM model)
    flag_rows = await db.execute(text("SELECT id, dev, email_verified, approved FROM users"))
    flag_map = {row.id: row for row in flag_rows}
    return {
        "users": [
            {
                "id": u.id,
                "email": u.email,
                "username": u.username,
                "first_name": u.first_name,
                "last_name": u.last_name,
                "company": getattr(u, "company", None),
                "admin": u.admin,
                "dev": bool(getattr(flag_map.get(u.id), "dev", False)),
                "is_active": u.is_active,
                "email_verified": getattr(flag_map.get(u.id), "email_verified", True) is not False,
                "approved": getattr(flag_map.get(u.id), "approved", True) is not False,
                "newsletter": getattr(u, "newsletter", False),
                "created_at": u.created_at.isoformat() if u.created_at else None,
            }
            for u in users
        ]
    }


@app.get("/admin/users/{user_id}", response_model=dict)
async def admin_get_user(
    user_id: int,
    admin: User = Depends(RequireAdminUser(data=True)),
    db: AsyncSession = Depends(get_db),
):
    """Get a single user. Admin only."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    dev_flag = await db.scalar(text("SELECT dev FROM users WHERE id = :id"), {"id": user_id})
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "company": getattr(user, "company", None),
        "admin": user.admin,
        "dev": bool(dev_flag),
        "is_active": user.is_active,
        "newsletter": getattr(user, "newsletter", False),
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


SYSTEM_EMAILS = {SYSTEM_ADMIN_EMAIL, DEV_EMAIL}


@app.patch("/admin/users/{user_id}", response_model=dict)
async def admin_update_user(
    user_id: int,
    body: AdminUserUpdate,
    admin: User = Depends(RequireAdminUser(data=True)),
    db: AsyncSession = Depends(get_db),
):
    """Update a user's credentials/role/status. Admin only."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="user not found")

    # Protect system accounts (admin@webmap.local and dev@local)
    if user.email in SYSTEM_EMAILS:
        if body.admin is False:
            raise HTTPException(status_code=400, detail="cannot remove admin from system account")
        if body.is_active is False:
            raise HTTPException(status_code=400, detail="cannot deactivate system account")

    if body.admin is not None:
        user.admin = body.admin
    if body.is_active is not None:
        user.is_active = body.is_active
    if body.first_name is not None:
        user.first_name = body.first_name
    if body.last_name is not None:
        user.last_name = body.last_name
    if body.company is not None:
        user.company = body.company
    if body.email is not None:
        user.email = str(body.email)
    if body.username is not None:
        # Check uniqueness
        clash = await db.scalar(select(User).where(User.username == body.username, User.id != user_id))
        if clash:
            raise HTTPException(status_code=409, detail="username already taken")
        user.username = body.username
    if body.password is not None:
        user.hashed_password = hash_password(body.password)

    await db.commit()

    # Handle raw-SQL flags (columns not in the ORM model)
    if body.dev is not None:
        await db.execute(text("UPDATE users SET dev = :dev WHERE id = :id"), {"dev": body.dev, "id": user_id})
        await db.commit()
    if body.approved is not None:
        await db.execute(text("UPDATE users SET approved = :v WHERE id = :id"), {"v": body.approved, "id": user_id})
        await db.commit()
    if body.email_verified is not None:
        await db.execute(
            text("UPDATE users SET email_verified = :v, verify_token = NULL, verify_token_expires = NULL WHERE id = :id"),
            {"v": body.email_verified, "id": user_id})
        await db.commit()

    await db.refresh(user)
    row = (await db.execute(
        text("SELECT dev, email_verified, approved FROM users WHERE id = :id"), {"id": user_id}
    )).one()
    return {"id": user.id, "email": user.email, "admin": user.admin, "dev": bool(row.dev),
            "is_active": user.is_active, "email_verified": row.email_verified is not False,
            "approved": row.approved is not False}


@app.post("/admin/users/{user_id}/approve", response_model=dict)
async def admin_approve_user(
    user_id: int,
    admin: User = Depends(RequireAdminUser(data=True)),
    db: AsyncSession = Depends(get_db),
):
    """One-click approval for a pending account. Admin only."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    await db.execute(text("UPDATE users SET approved = TRUE WHERE id = :id"), {"id": user_id})
    await db.commit()
    return {"ok": True, "id": user_id, "approved": True}


@app.delete("/admin/users/{user_id}", response_model=dict)
async def admin_delete_user(
    user_id: int,
    hard: bool = False,
    admin: User = Depends(RequireAdminUser(data=True)),
    db: AsyncSession = Depends(get_db),
):
    """Deactivate (soft-delete) or permanently delete a user.

    Query params:
        hard=true  — permanently removes the user from DB and deletes their storage folder
    """
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    if user.email in SYSTEM_EMAILS:
        raise HTTPException(status_code=400, detail="cannot delete system account")

    if hard:
        # Hard delete: remove storage via dataset backend, then delete from DB
        import httpx
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.delete(f"{DATASET_SERVICE_URL}/internal/delete-user/{user.id}",
                                           headers=_internal_headers(), timeout=10.0)
                resp.raise_for_status()
        except Exception:
            logger.warning("Could not delete storage for user %s", user.id)

        # Delete all refresh tokens
        await db.execute(text("DELETE FROM refresh_tokens WHERE user_id = :uid"), {"uid": user.id})
        await db.delete(user)
        await db.commit()
        return {"ok": True, "id": user_id, "action": "hard_deleted"}
    else:
        user.is_active = False
        await db.commit()
        return {"ok": True, "id": user_id, "action": "deactivated"}
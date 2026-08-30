"""Broker auth.

Users: the platform access JWT (cookie or bearer), verified locally with
the shared JWT_SECRET — same model as ops-backend and the MCP server.

Workers: a static service token (SIM_WORKER_TOKEN) in the X-Worker-Token
header. Workers additionally receive short-lived USER tokens minted here
so result datasets are created under the submitting user's account.
"""

from __future__ import annotations

import os
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException, Request

JWT_SECRET = os.getenv("JWT_SECRET", "UltraSecretKey")
JWT_ALG = os.getenv("JWT_ALG", "HS256")
ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")
WORKER_TOKEN = os.getenv("SIM_WORKER_TOKEN", "")
UPLOAD_TOKEN_HOURS = int(os.getenv("SIM_UPLOAD_TOKEN_HOURS", "48"))


class User:
    def __init__(self, claims: dict, raw_token: str) -> None:
        self.id = int(claims.get("sub") or claims.get("id") or 0)
        self.admin = bool(claims.get("admin"))
        self.username = str(claims.get("username") or claims.get("email") or "")
        self.raw_token = raw_token


async def require_user(request: Request) -> User:
    token = request.cookies.get(ACCESS_COOKIE_NAME)
    if not token:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="not authenticated")
    try:
        claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except Exception:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    if claims.get("typ") != "access":
        raise HTTPException(status_code=401, detail="not an access token")
    return User(claims, token)


async def require_worker(request: Request) -> str:
    supplied = request.headers.get("x-worker-token", "")
    if not WORKER_TOKEN or not secrets.compare_digest(supplied, WORKER_TOKEN):
        raise HTTPException(status_code=401, detail="invalid worker token")
    return request.headers.get("x-worker-id", "worker")


def mint_user_token(user_id: int, username: str = "") -> str:
    """Short-lived access JWT for the job owner — lets the worker create
    and upload the result dataset AS the user (ownership, grants, quotas
    all apply normally downstream)."""
    now = datetime.now(timezone.utc)
    return jwt.encode({
        "sub": str(user_id),
        "username": username,
        "typ": "access",
        "admin": False,
        "iat": now,
        "exp": now + timedelta(hours=UPLOAD_TOKEN_HOURS),
    }, JWT_SECRET, algorithm=JWT_ALG)

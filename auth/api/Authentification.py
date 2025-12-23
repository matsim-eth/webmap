# auth/api/Authentification.py

from datetime import datetime, timezone
from sqlalchemy import select
from fastapi import HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from auth.api.db import get_db
from auth.api.db_models import User
from auth.api.security import decode_token
from auth.api import config

bearer = HTTPBearer(auto_error=False)


def token_from_creds(creds: HTTPAuthorizationCredentials | None) -> str:
    return creds.credentials if creds else ""


def authenticated(access_token: str) -> bool:
    if not access_token:
        return False
    try:
        decoded = decode_token(access_token)
    except Exception:
        return False

    exp = decoded.get("exp")
    if exp is None:
        return False

    exp_dt = datetime.fromtimestamp(exp, tz=timezone.utc) if isinstance(exp, (int, float)) else exp
    return exp_dt > datetime.now(timezone.utc)


def is_admin(access_token: str) -> bool:
    try:
        decoded = decode_token(access_token)
    except Exception:
        return False
    return decoded.get("admin") == "true"


def get_user_id(access_token: str) -> str | None:
    try:
        decoded = decode_token(access_token)
    except Exception:
        return None
    return decoded.get("sub")


def RequireUser():
    async def dependency(
        creds: HTTPAuthorizationCredentials | None = Depends(bearer),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        access_token = token_from_creds(creds)

        if not authenticated(access_token):
            raise HTTPException(
                status_code=status.HTTP_303_SEE_OTHER,
                detail="invalid auth token",
                headers={"Location": config.login_url},
            )

        user_id = get_user_id(access_token)
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid user")

        user = await db.scalar(select(User).where(User.id == int(user_id)))
        if not user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user not found")

        return user

    return dependency


def RequireAdminUser():
    async def dependency(user: User = Depends(RequireUser())) -> User:
        if not getattr(user, "admin", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin requires")
        return user

    return dependency
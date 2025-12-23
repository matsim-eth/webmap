# auth/api/Authentification.py

from datetime import datetime, timezone
from functools import wraps
import inspect

from sqlalchemy import select
from fastapi import HTTPException, status, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import RedirectResponse

from auth.api.config import login_url
from auth.api.db import get_db
from auth.api.db_models import User
from auth.api.security import decode_token
from auth.api import config



def authenticated(access_token: str) -> bool:
    try:
        decode = decode_token(access_token)
    except Exception:
        return False

    exp = decode.get("exp")
    if exp is None:
        return False

    if isinstance(exp, (int, float)):
        exp_dt = datetime.fromtimestamp(exp, tz=timezone.utc)
    else:
        exp_dt = exp

    now = datetime.now(timezone.utc)
    if exp_dt <= now:
        return False

    return True


def is_admin(access_token: str) -> bool:
    try:
        decode = decode_token(access_token)
        return decode.get("admin") == "true"
    except Exception:
        return False


def get_user_email(access_token: str) -> str | None:
    try:
        decode = decode_token(access_token)
        return decode.get("email")
    except Exception:
        return None


def get_user_id(access_token: str) -> str | None:
    try:
        decode = decode_token(access_token)
        return decode.get("sub")
    except Exception:
        return None


def get_user(access_token: str, user_id: int | None) -> User | None:
    # Achtung: get_db ist async-Generator, das hier funktioniert nur,
    # wenn du das später sauber mit FastAPI-Dependencies löst.
    if user_id is None:
        user_id = get_user_id(access_token)
    if user_id is None:
        return None

    # Platzhalter – korrekter Weg wäre: Session als Dependency reinreichen
    raise NotImplementedError("get_user sollte mit AsyncSession-Dependency benutzt werden")


def RequireAuth(func):
    @wraps(func)
    async def wrapper(*args, access_token: str = "", **kwargs):
        if not authenticated(access_token):
            return RedirectResponse(url=config.login_url, status_code=303)

        kwargs.pop("access_token", None)

        result = func(*args, access_token=access_token, **kwargs)
        if inspect.isawaitable(result):
            result = await result
        return result

    return wrapper


def RequireAdmin(func):
    @wraps(func)
    async def wrapper(*args, access_token: str = "", **kwargs):
        if not authenticated(access_token) or not is_admin(access_token):
            raise HTTPException(
                status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
                detail="admin requires",
            )
        kwargs.pop("access_token", None)

        result = func(*args,access_token=access_token, **kwargs)
        if inspect.isawaitable(result):
            result = await result
        return result

    return wrapper

def RequireUser():
    async def dependency(
        access_token: str = "",
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if not authenticated(access_token):
            raise HTTPException(
                status_code=status.HTTP_303_SEE_OTHER,
                detail="invalid auth token",
                headers={"Location": config.login_url},
            )
        user_id = get_user_id(access_token)
        if user_id is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid user",
            )

        result = await db.execute(select(User).where(User.id == int(user_id)))
        user = result.scalar_one_or_none()
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="user not found",
            )

        return user

    return dependency
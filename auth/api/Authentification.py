# auth/api/Authentification.py

from datetime import datetime, timezone
from functools import wraps
import inspect

from sqlalchemy import select
from fastapi import HTTPException, status

from auth.api.db import get_db
from auth.api.db_models import User
from auth.api.security import decode_token
from auth.api import config


# Öffentliche Setter bleiben erhalten, delegieren aber in config.py
def set_database_url(url: str) -> None:
    config.set_database_url(url)


def set_database_user(user: str) -> None:
    config.set_database_user(user)


def set_database_password(password: str) -> None:
    config.set_database_password(password)


def set_database_table(table: str) -> None:
    config.set_database_table(table)


def set_secret(secret: str) -> None:
    config.set_secret(secret)


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
    async def wrapper(*args, auth_token: str = "", **kwargs):
        if not authenticated(auth_token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid auth token",
            )

        kwargs.pop("auth_token", None)

        result = func(*args, **kwargs)
        if inspect.isawaitable(result):
            result = await result
        return result

    return wrapper


def RequireAdmin(func):
    @wraps(func)
    async def wrapper(*args, auth_token: str = "", **kwargs):
        if not authenticated(auth_token) or not is_admin(auth_token):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="admin privileges required",
            )

        kwargs.pop("auth_token", None)

        result = func(*args, **kwargs)
        if inspect.isawaitable(result):
            result = await result
        return result

    return wrapper


def RequireUser():
    async def dependency(auth_token: str = ""):
        if not authenticated(auth_token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid auth token",
            )

        user_id = get_user_id(auth_token)
        if user_id is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid user",
            )

        # Auch hier eigentlich: AsyncSession als Dependency holen,
        # nicht direkt get_db() aufrufen.
        raise NotImplementedError("RequireUser sollte mit AsyncSession-Dependency umgesetzt werden")

    return dependency
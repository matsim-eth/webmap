from datetime import datetime, timezone
from functools import wraps
import inspect

from sqlalchemy import select
from fastapi import HTTPException, status

from auth.api.db import get_db
from auth.api.db_models import User
from auth.api.security import decode_token

secret_key = "" # Secret Key for decrypting JWT Token
database_url=""
database_user=""
database_password=""
database_table=""

def set_database_url(url):
    database_url = url
def set_database_user(user):
    database_user = user
def set_database_password(password):
    database_password = password
def set_database_table(table):
    database_table = table
def set_secret(secret: str):
    secret_key = secret

def authenticated(access_token: str) -> bool:
    try:
        decode = decode_token(access_token)
    except Exception:
        return False

    exp = decode.get("exp")
    if exp is None:
        return False

    # exp kann entweder ein Unix-Timestamp oder ein datetime-Objekt sein
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
        if decode.get("admin") == "true":
            return True
        return False
    except:
        return False
def get_user_email(access_token: str) -> str:
    try:
        decode = decode_token(access_token)
        return decode.get("email")
    except:
        return None
def get_user_id(access_token: str) -> str:
    try:
        decode = decode_token(access_token);
        return decode.get("sub")
    except:
        return None
###FAST--API
def get_user(access_token: str,user_id: int) -> str:
    if user_id is None:
        user_id = get_user_id(access_token)
    if user_id is None:
        return None
    database = get_db()
    user = database.scalar(select(User).where(User.id==user_id))
    return user


def RequireAuth(func):
    @wraps(func)
    async def wrapper(*args, auth_token: str = "", **kwargs):
        if not authenticated(auth_token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid auth token",
            )

        # auth_token nicht an die eigentliche Funktion weitergeben
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

        database = get_db()
        user = database.scalar(select(User).where(User.id == user_id))
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="user not found",
            )

        return user

    return dependency

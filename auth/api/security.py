import os
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import jwt
import bcrypt

from auth.api.db_models import User

SECRET_KEY = os.getenv("JWT_SECRET", "UltraSecretKey")
ALGORITHM = os.getenv("JWT_ALG", "HS256")

ACCESS_MINUTES = int(os.getenv("ACCESS_TOKEN_MINUTES", "15"))
REFRESH_DAYS = int(os.getenv("REFRESH_TOKEN_DAYS", "14"))

BCRYPT_ROUNDS = int(os.getenv("BCRYPT_ROUNDS", "12"))

def hash_password(pw: str) -> str:
    salt = bcrypt.gensalt(rounds=BCRYPT_ROUNDS)
    return bcrypt.hashpw(pw.encode("utf-8"), salt).decode("utf-8")

def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

def create_access_token(user :  User) -> str:
    now = _utcnow()
    payload = {
        "sub": str(user.id),
        "admin": bool(user.admin),
        "typ": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=ACCESS_MINUTES)).timestamp()),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def create_refresh_token(user : User) -> tuple[str, str, datetime]:
    now = _utcnow()
    jti = secrets.token_hex(16)

    exp = now + timedelta(days=REFRESH_DAYS)
    payload = {
        "sub": str(user.id),
        "admin": bool(user.admin), #Should be deleted?
        "typ": "refresh",
        "jti": jti,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    token = jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
    return token, jti, exp

def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
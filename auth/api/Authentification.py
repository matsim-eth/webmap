import datetime

from sqlalchemy import select

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
    except:
        return False
    now = datetime.now(datetime.timezone.utc)
    if decode.get("exp") > now:
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

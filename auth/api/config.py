# auth/api/config.py

import os

# Standardwerte, z.B. über Umgebungsvariablen überschreibbar
database_url: str = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://user:pass@auth_db:5432/appdb",
)

database_user: str = os.getenv("DATABASE_USER", "")
database_password: str = os.getenv("DATABASE_PASSWORD", "")
database_table: str = os.getenv("DATABASE_TABLE", "")
secret_key: str = os.getenv("AUTH_SECRET_KEY", "")


def set_database_url(url: str) -> None:
    global database_url
    database_url = url


def set_database_user(user: str) -> None:
    global database_user
    database_user = user


def set_database_password(password: str) -> None:
    global database_password
    database_password = password


def set_database_table(table: str) -> None:
    global database_table
    database_table = table


def set_secret(key: str) -> None:
    global secret_key
    secret_key = key
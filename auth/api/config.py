# auth/api/config.py

import os

# Standardwerte, z.B. über Umgebungsvariablen überschreibbar
database_url: str = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://user:pass@auth_db:5432/appdb",
)


secret_key: str = os.getenv("AUTH_SECRET_KEY", "")
login_url: str = os.getenv("LOGIN_URL", "")


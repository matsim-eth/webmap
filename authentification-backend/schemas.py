# schemas.py

from typing import Optional
from pydantic import BaseModel, EmailStr, Field, model_validator


class RegisterCredentialsModel(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    first_name: str
    last_name: str
    company: Optional[str] = None
    username: Optional[str] = None
    newsletter: bool = False


class LoginModel(BaseModel):
    password: str

    email: Optional[str] = None          # kein EmailStr — muss auch "dev@local" akzeptieren
    username: Optional[str] = None
    identifier: Optional[str] = None     # "email oder username" (Frontend kann das schicken)

    @model_validator(mode="after")
    def _at_least_one(self):
        if not (self.email or self.username or self.identifier):
            raise ValueError("email or username required")
        return self


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshIn(BaseModel):
    refresh_token: Optional[str] = None


class AccessIn(BaseModel):
    access_token: str


class AdminUserUpdate(BaseModel):
    admin: Optional[bool] = None
    dev: Optional[bool] = None
    is_active: Optional[bool] = None
    approved: Optional[bool] = None
    email_verified: Optional[bool] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    company: Optional[str] = None
    email: Optional[EmailStr] = None
    username: Optional[str] = None
    password: Optional[str] = Field(None, min_length=8)


class ResendVerificationIn(BaseModel):
    email: Optional[str] = None


class ApiTokenCreateIn(BaseModel):
    """Personal API token (MCP / programmatic access)."""
    name: str = Field(default="API token", max_length=100)
    days: int = Field(default=90, ge=1, le=365)


class ApiTokenVerifyIn(BaseModel):
    token: str
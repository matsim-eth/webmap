from typing import Optional
from pydantic import BaseModel, EmailStr, Field

class RegisterCredentialsModel(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    first_name: str
    last_name: str
    username: Optional[str] = None
    newsletter: bool = False

class LoginModel(BaseModel):
    email: EmailStr
    password: str

class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"

class RefreshIn(BaseModel):
    refresh_token: str
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="AEOLUS_", extra="ignore"
    )

    project_name: str = "Aeolus"
    api_prefix: str = "/api/v1"
    debug: bool = False

    database_url: str = "postgresql+asyncpg://aeolus:aeolus@localhost:5432/aeolus"

    # openssl rand -hex 32
    secret_key: str = Field(min_length=32)
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 30

    cors_origins: list[str] = ["http://localhost:5173"]

    # Bootstrap admin, created on first startup if no users exist.
    first_admin_username: str = "admin"
    first_admin_password: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()

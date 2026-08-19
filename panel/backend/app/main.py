import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select

from app.api.v1 import api_router
from app.core.config import settings
from app.core.db import SessionLocal, engine
from app.core.security import hash_password
from app.models.user import User, UserRole

logger = logging.getLogger("aeolus")


async def bootstrap_admin() -> None:
    if not settings.first_admin_password:
        return
    async with SessionLocal() as session:
        count = await session.scalar(select(func.count()).select_from(User))
        if count:
            return
        session.add(
            User(
                username=settings.first_admin_username,
                password_hash=hash_password(settings.first_admin_password),
                role=UserRole.admin,
            )
        )
        await session.commit()
        logger.warning("Created bootstrap admin %r", settings.first_admin_username)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bootstrap_admin()
    yield
    await engine.dispose()


app = FastAPI(
    title=f"{settings.project_name} Panel API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.api_prefix)


@app.get("/health", tags=["meta"])
async def health() -> dict[str, str]:
    return {"status": "ok"}

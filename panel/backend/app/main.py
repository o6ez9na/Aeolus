import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import api_router
from app.core.config import settings
from app.core.db import SessionLocal, engine
from app.services import bootstrap

logger = logging.getLogger("aeolus")


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with SessionLocal() as session:
        await bootstrap.run(session)
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

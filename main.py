from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.concurrency import run_in_threadpool

from backend.database import database_path, migrate
from backend.evaluations import router


def create_app(db_path=None):
    @asynccontextmanager
    async def lifespan(application):
        await run_in_threadpool(migrate, application.state.database_path)
        yield

    application = FastAPI(lifespan=lifespan)
    application.state.database_path = db_path if db_path is not None else database_path()
    application.include_router(router)

    @application.get("/health")
    async def health():
        return {"status": "ok"}

    return application


app = create_app()

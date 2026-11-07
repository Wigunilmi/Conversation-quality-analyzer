from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.concurrency import run_in_threadpool

from backend.database import database_path, migrate
from backend.evaluations import router
from backend.groups import router as groups_router


def create_app(db_path=None, organizers_transport=None):
    @asynccontextmanager
    async def lifespan(application):
        await run_in_threadpool(migrate, application.state.database_path)
        yield

    application = FastAPI(lifespan=lifespan)
    application.state.database_path = db_path if db_path is not None else database_path()
    application.state.organizers_transport = organizers_transport
    application.include_router(router)
    application.include_router(groups_router)

    @application.get("/health")
    async def health():
        return {"status": "ok"}

    return application


app = create_app()

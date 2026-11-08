from contextlib import asynccontextmanager
import os

from fastapi import FastAPI, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer
from starlette.concurrency import run_in_threadpool

from backend.database import database_path, migrate
from backend.evaluations import router
from backend.groups import router as groups_router
from backend.conversations import router as conversations_router
from backend.checklists import router as checklists_router
from backend.batch import router as batch_router
from backend.appeals import router as appeals_router
from backend.postgres import is_postgres
from backend.migrate_postgres import check_postgres_schema
from backend.security import ApiTokenMiddleware, validate_origin


def create_app(db_path=None, organizers_transport=None):
    token = os.environ.get("API_AUTH_TOKEN")
    origin = os.environ.get("FRONTEND_ORIGIN")
    if os.environ.get("VERCEL"):
        if not token or len(token) < 32:
            raise RuntimeError("Set API_AUTH_TOKEN with at least 32 characters on Vercel")
        if not origin:
            raise RuntimeError("FRONTEND_ORIGIN is required on Vercel")
    if origin:
        validate_origin(origin)

    @asynccontextmanager
    async def lifespan(application):
        target = application.state.database_path
        await run_in_threadpool(check_postgres_schema if is_postgres(target) else migrate, target)
        yield

    application = FastAPI(lifespan=lifespan)
    application.state.database_path = db_path if db_path is not None else database_path()
    application.state.organizers_transport = organizers_transport
    bearer = HTTPBearer(scheme_name="BearerAuth", auto_error=False,
                        description="API service token. Enter only the token; Swagger UI adds the Bearer prefix.")
    # This dependency documents/extracts the header only. The existing middleware
    # remains responsible for validating the token and preserving local no-token mode.
    for api_router in (router, groups_router, conversations_router, checklists_router, batch_router, appeals_router):
        application.include_router(api_router, dependencies=[Security(bearer)])
    if token:
        application.add_middleware(ApiTokenMiddleware, token=token)
    if origin:
        # CORS wraps authentication so preflight and unauthorized responses have CORS headers.
        application.add_middleware(CORSMiddleware, allow_origins=[origin], allow_methods=["GET", "POST"],
                                   allow_headers=["Content-Type", "Authorization"], allow_credentials=False)

    @application.get("/health")
    async def health():
        return {"status": "ok"}

    return application


app = create_app()

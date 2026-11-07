"""Optional local and mandatory Vercel bearer authentication for /api/* routes."""

import secrets
from urllib.parse import urlsplit

from starlette.responses import JSONResponse


def validate_origin(origin):
    try:
        parsed = urlsplit(origin)
        parsed.port
    except ValueError:
        raise RuntimeError("FRONTEND_ORIGIN must be one exact origin without a path or wildcard") from None
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment or "*" in origin):
        raise RuntimeError("FRONTEND_ORIGIN must be one exact origin without a path or wildcard")
    return origin


class ApiTokenMiddleware:
    def __init__(self, app, token):
        self.app = app
        self.token = token.encode("utf-8")

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].startswith("/api/") and scope["method"] != "OPTIONS":
            headers = dict(scope["headers"])
            value = headers.get(b"authorization", b"")
            scheme, _, token = value.partition(b" ")
            if scheme.lower() != b"bearer" or not secrets.compare_digest(token, self.token):
                response = JSONResponse({"error": "unauthorized"}, status_code=401,
                                        headers={"WWW-Authenticate": "Bearer"})
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)

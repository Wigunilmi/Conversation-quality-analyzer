import pytest
from fastapi.testclient import TestClient

from backend.database import database_path, migrate
from backend.postgres import PostgresDatabase, parameter_sql
from main import create_app


TOKEN = "test-only-token-with-at-least-32-characters"
ORIGIN = "https://frontend.example"


def test_database_selection_and_no_secret_repr(monkeypatch, tmp_path):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("CQA_DATABASE_PATH", str(tmp_path / "local.sqlite3"))
    assert database_path() == tmp_path / "local.sqlite3"
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:secret@localhost/test")
    target = database_path()
    assert isinstance(target, PostgresDatabase) and "secret" not in repr(target)
    with pytest.raises(RuntimeError, match="migrate_postgres"):
        migrate(target)


def test_parameters_are_bound_and_literals_preserved():
    assert parameter_sql("SELECT '?' AS literal WHERE id = ?") == "SELECT '?' AS literal WHERE id = %s"
    assert parameter_sql("SELECT '100%' WHERE name = ?") == "SELECT '100%%' WHERE name = %s"


def test_auth_and_exact_cors(monkeypatch, tmp_path):
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("API_AUTH_TOKEN", TOKEN)
    monkeypatch.setenv("FRONTEND_ORIGIN", ORIGIN)
    with TestClient(create_app(tmp_path / "auth.sqlite3")) as client:
        assert client.get("/health").status_code == 200
        for method, path in (("GET", "/api/conversations"), ("POST", "/api/evaluate"), ("POST", "/api/evaluate-batch")):
            response = client.request(method, path, headers={"Origin": ORIGIN})
            assert response.status_code == 401 and response.json() == {"error": "unauthorized"}
            assert response.headers["access-control-allow-origin"] == ORIGIN
        assert client.get("/api/conversations", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert client.get("/api/conversations", headers={"Authorization": "Bearer " + TOKEN}).status_code == 200
        preflight = {"Origin": ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}
        response = client.options("/api/evaluate", headers=preflight)
        assert response.status_code == 200 and response.headers["access-control-allow-origin"] == ORIGIN
        preflight["Origin"] = "https://other.example"
        response = client.options("/api/evaluate", headers=preflight)
        assert response.status_code == 400 and "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize("origin", ["*", "https://frontend.example/", "https://frontend.example/path", "https://user:secret@frontend.example", "https://frontend.example:bad"])
def test_invalid_origin_rejected(monkeypatch, tmp_path, origin):
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("FRONTEND_ORIGIN", origin)
    with pytest.raises(RuntimeError, match="FRONTEND_ORIGIN"):
        create_app(tmp_path / "unused.sqlite3")


def test_vercel_configuration_fails_closed(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.delenv("API_AUTH_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="API_AUTH_TOKEN"):
        create_app()
    monkeypatch.setenv("API_AUTH_TOKEN", TOKEN)
    monkeypatch.delenv("FRONTEND_ORIGIN", raising=False)
    with pytest.raises(RuntimeError, match="FRONTEND_ORIGIN"):
        create_app()
    monkeypatch.setenv("FRONTEND_ORIGIN", ORIGIN)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        create_app()


def test_main_entrypoint_does_not_open_database_on_import(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("API_AUTH_TOKEN", TOKEN)
    monkeypatch.setenv("FRONTEND_ORIGIN", ORIGIN)
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:placeholder@localhost/unconnected")
    application = create_app()
    assert isinstance(application.state.database_path, PostgresDatabase)
    assert "/api/conversations" in application.openapi()["paths"]


@pytest.mark.parametrize("authenticated", [False, True])
def test_bearer_openapi_for_api_only_preserves_middleware(monkeypatch, tmp_path, authenticated):
    monkeypatch.delenv("VERCEL", raising=False)
    if authenticated:
        monkeypatch.setenv("API_AUTH_TOKEN", TOKEN)
    else:
        monkeypatch.delenv("API_AUTH_TOKEN", raising=False)
    with TestClient(create_app(tmp_path / "docs.sqlite3")) as client:
        assert client.get("/docs").status_code == 200
        response = client.get("/openapi.json")
        assert response.status_code == 200
        schema = response.json()
        bearer = schema["components"]["securitySchemes"]["BearerAuth"]
        assert bearer["type"] == "http" and bearer["scheme"] == "bearer"
        assert "bearerFormat" not in bearer  # The service token is opaque, not a JWT.
        for path, operations in schema["paths"].items():
            for method, operation in operations.items():
                if method not in {"get", "post", "put", "patch", "delete", "head", "options"}:
                    continue
                if path.startswith("/api/"):
                    assert operation["security"] == [{"BearerAuth": []}]
                else:
                    assert "security" not in operation
        assert TOKEN not in response.text
        assert client.get("/health").status_code == 200
        assert client.get("/api/conversations").status_code == (401 if authenticated else 200)
        assert client.get("/api/conversations", headers={"Authorization": "Bearer wrong"}).status_code == (401 if authenticated else 200)
        assert client.get("/api/conversations", headers={"Authorization": "Bearer " + TOKEN}).status_code == 200

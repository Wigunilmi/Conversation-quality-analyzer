import json

from fastapi.testclient import TestClient
import httpx
import pytest

from backend.database import connect, migrate, seed_demo
from main import create_app


@pytest.fixture
def gateway(tmp_path, monkeypatch):
    path = tmp_path / "groups.sqlite3"
    migrate(path)
    seed_demo(path)
    with connect(path) as connection:
        synthetic = json.loads(connection.execute("SELECT payload FROM conversations").fetchone()[0])
    records = [{**synthetic, "conversation_id": f"imported-{index:03}", "group_id": "upstream-group",
                "loaded_at": "old", "custom_metadata": {"source": "synthetic"}} for index in (1, 2)]
    state = {"records": records, "requests": [], "status": 200}
    monkeypatch.setenv("CQA_API_URL", "https://organizers.example/conversations?source=qa&group_id=stale")
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    def respond(request):
        state["requests"].append(request)
        if state.get("timeout"):
            raise httpx.ReadTimeout("synthetic timeout", request=request)
        if "raw" in state:
            return httpx.Response(state["status"], content=state["raw"])
        return httpx.Response(state["status"], json=state.get("payload", {
            "isSuccess": True, "data": {"records": state["records"]}}))

    with TestClient(create_app(path, organizers_transport=httpx.MockTransport(respond))) as client:
        yield client, path, state


def conversations(path):
    with connect(path) as connection:
        return {row["id"]: json.loads(row["payload"]) for row in connection.execute("SELECT * FROM conversations")}


def test_group_load_sends_get_query_and_preserves_fields(gateway):
    client, path, state = gateway
    response = client.post("/api/groups/DEV%20%26%20QA/load")
    assert response.status_code == 200 and response.json() == {"loaded": 2}
    request = state["requests"][0]
    assert request.method == "GET" and request.content == b""
    assert request.url.params.get_list("group_id") == ["DEV & QA"]
    assert request.url.params["source"] == "qa"
    saved = conversations(path)
    assert len(saved) == 3  # The synthetic seed plus the two imported conversations.
    for record in state["records"]:
        loaded = saved[record["conversation_id"]]
        assert loaded["group_id"] == "DEV & QA" and loaded["loaded_at"].endswith("Z")
        assert loaded["transcript"] == record["transcript"]
        assert loaded["custom_metadata"] == record["custom_metadata"]


def test_reload_updates_existing_rows_without_duplicates(gateway):
    client, path, state = gateway
    assert client.post("/api/groups/DEV/load").json() == {"loaded": 2}
    state["records"][0]["transcript"] = [{"speaker": "client", "text": "Updated synthetic text"}]
    state["records"][0]["channel"] = "voice call"
    assert client.post("/api/groups/DEV/load").json() == {"loaded": 2}
    assert len(conversations(path)) == 3
    assert conversations(path)["imported-001"]["transcript"] == state["records"][0]["transcript"]
    with connect(path) as connection:
        assert connection.execute("SELECT channel FROM conversations WHERE id = 'imported-001'").fetchone()[0] == "voice call"


def test_loaded_conversation_can_be_evaluated_and_reload_keeps_evaluation(gateway):
    client, path, state = gateway
    assert client.post("/api/groups/DEV/load").status_code == 200
    response = client.post("/api/evaluate", json={"conversation_id": "imported-001"})
    assert response.status_code == 200
    view = response.json()
    assert view["conversation_id"] == "imported-001" and view["group_id"] == "DEV"
    assert view["checklist_id"] == "chat" and view["checklist_version"] == 1
    assert view["model"].startswith("MOCK") and view["results"]
    assert client.post("/api/groups/DEV/load").json() == {"loaded": 2}
    with connect(path) as connection:
        assert connection.execute("SELECT id FROM evaluations").fetchone()[0] == view["id"]
        assert connection.execute("SELECT COUNT(*) FROM evaluation_results").fetchone()[0] == len(view["results"])
    assert len(conversations(path)) == 3


def test_missing_url_matches_reference(gateway, monkeypatch):
    client, path, state = gateway
    monkeypatch.delenv("CQA_API_URL")
    response = client.post("/api/groups/DEV/load")
    assert response.status_code == 500
    assert response.json() == {"error": "CQA_API_URL is not set (see .env.example)"}
    assert state["requests"] == [] and len(conversations(path)) == 1


def test_upstream_failure_matches_reference(gateway):
    client, path, state = gateway
    state["payload"] = {"isSuccess": False, "error": "synthetic access denied"}
    state["status"] = 403
    response = client.post("/api/groups/DEV/load")
    assert response.status_code == 502
    assert response.json() == {"error": "Organizers API: synthetic access denied"}
    assert len(conversations(path)) == 1


@pytest.mark.parametrize("payload", [
    [], {"isSuccess": True}, {"isSuccess": True, "data": {"records": {}}},
    {"isSuccess": True, "data": {"records": [{"channel": "agent chat", "transcript": []}]}},
])
def test_invalid_upstream_payload_does_not_write(gateway, payload):
    client, path, state = gateway
    state["payload"] = payload
    response = client.post("/api/groups/DEV/load")
    assert response.status_code == 502 and "error" in response.json()
    assert len(conversations(path)) == 1


def test_mixed_valid_and_invalid_records_do_not_partially_import(gateway):
    client, path, state = gateway
    state["records"].append({"conversation_id": "broken"})
    assert client.post("/api/groups/DEV/load").status_code == 502
    assert len(conversations(path)) == 1


def test_upstream_timeout_does_not_write_or_expose_url(gateway, monkeypatch):
    client, path, state = gateway
    monkeypatch.setenv("CQA_API_URL", "https://organizers.example/?token=synthetic-secret")
    state["timeout"] = True
    response = client.post("/api/groups/DEV/load")
    assert response.status_code == 502
    assert response.json() == {"error": "Organizers API: request failed"}
    assert "synthetic-secret" not in response.text and len(conversations(path)) == 1


def test_non_json_response_does_not_write(gateway):
    client, path, state = gateway
    state["raw"] = b"<html>upstream unavailable</html>"
    state["status"] = 503
    assert client.post("/api/groups/DEV/load").status_code == 502
    assert len(conversations(path)) == 1


def test_empty_group_returns_zero_and_preserves_existing_conversations(gateway):
    client, path, state = gateway
    state["records"] = []
    response = client.post("/api/groups/EMPTY/load")
    assert response.status_code == 200 and response.json() == {"loaded": 0}
    assert len(conversations(path)) == 1


def test_database_failure_rolls_back_whole_group(gateway):
    client, path, state = gateway
    with connect(path) as connection, connection:
        connection.execute("""CREATE TRIGGER fail_import BEFORE INSERT ON conversations
            WHEN NEW.id = 'imported-002' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END""")
    response = client.post("/api/groups/DEV/load")
    assert response.status_code == 500
    assert len(conversations(path)) == 1

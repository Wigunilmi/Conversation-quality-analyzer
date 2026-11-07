from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json

from fastapi.testclient import TestClient
import pytest

from backend import evaluations
from backend.checklists import create_version
from backend.database import ROOT, connect, migrate, seed_demo
from backend.evaluations import load_context, save_evaluation
from main import create_app


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "checklists.sqlite3"
    migrate(path)
    seed_demo(path)
    return path


@pytest.fixture
def client(database, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Model calls are forbidden in checklist tests")

    monkeypatch.setattr(evaluations.evaluator, "evaluate", forbidden)
    monkeypatch.setattr(evaluations.evaluator, "_post", forbidden)
    with TestClient(create_app(database)) as api:
        yield api


def checklist():
    return json.loads((ROOT / "checklists" / "chat.json").read_text(encoding="utf-8"))


def saved_evaluation(database):
    context = load_context(database, "synthetic-chat-001")
    results = []
    for index, criterion in enumerate(context["checklist"]["criteria"]):
        result = {"criterion_id": criterion["id"], "na": False, "confidence": 0.9}
        if criterion["type"] == "scale":
            result["score"] = criterion["scale"]["max"]
        else:
            result["answer"] = "no" if index == 0 or criterion.get("critical_on") == "yes" else "yes"
        results.append(result)
    return save_evaluation(database, context, {"results": results, "model": "saved-fixture"}, 1)


def test_get_contract_shape(client):
    response = client.get("/api/checklists")
    assert response.status_code == 200
    item = response.json()[0]
    assert set(item) == {"id", "name", "channels", "active", "versions", "active_checklist"}
    assert item["id"] == "chat" and item["channels"] == ["agent chat"] and item["active"] == 1
    assert item["active_checklist"] == item["versions"][0]["checklist"]
    assert set(item["versions"][0]) == {"version", "created_at", "note", "checklist"}
    assert item["versions"][0]["created_at"].endswith("Z")


def test_create_set_transfers_channels_without_removing_old_versions(client):
    body = {"name": "New set", "channels": ["agent chat"], "checklist": checklist(), "note": "Initial"}
    response = client.post("/api/checklists", json=body)
    assert response.status_code == 200
    identifier = response.json()["id"]
    items = {item["id"]: item for item in client.get("/api/checklists").json()}
    assert items["chat"]["channels"] == [] and len(items["chat"]["versions"]) == 1
    created = items[identifier]
    assert created["name"] == "New set" and created["channels"] == ["agent chat"] and created["active"] == 1
    assert created["active_checklist"]["id"] == identifier
    assert created["versions"][0]["note"] == "Initial"


def test_new_version_activates_preserves_card_score_and_marks_list_outdated(client, database):
    old = saved_evaluation(database)
    original = client.get("/api/checklists").json()[0]["versions"][0]["checklist"]
    changed = deepcopy(original)
    changed["name"] = "Changed name"
    for index, criterion in enumerate(changed["criteria"]):
        criterion["weight"] = 100 if index == 0 else 0
    response = client.post("/api/checklists/chat/versions", json={"checklist": changed, "note": "Changed criterion weight"})
    assert response.status_code == 200 and response.json() == {"version": 2}
    item = client.get("/api/checklists").json()[0]
    assert item["active"] == 2 and item["name"] == "Changed name"
    assert item["versions"][0]["checklist"] == original
    assert item["versions"][1]["note"] == "Changed criterion weight"
    card = client.get("/api/conversations/synthetic-chat-001").json()
    assert set(card) == {"conversation", "evaluation", "history"}
    assert "outdated" not in card["evaluation"] and card["evaluation"] == old
    assert card["evaluation"]["totals"]["total"] == 90 and card["evaluation"]["checklist_version"] == 1
    assert card["history"][0]["total"] == 90
    row = client.get("/api/conversations").json()[0]
    assert row["outdated"] is True and row["total"] == 90
    with connect(database) as connection:
        assert connection.execute("SELECT checklist_version FROM evaluations").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM evaluations").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM evaluation_results").fetchone()[0] == 8
        assert connection.execute("SELECT active_version FROM channel_checklists").fetchone()[0] == 2


@pytest.mark.parametrize("invalid", [None, {}, {"criteria": []}, {"criteria": [{"id": "bad", "text": "Bad", "weight": -1, "type": "binary"}]}])
def test_invalid_version_does_not_change_database(client, database, invalid):
    response = client.post("/api/checklists/chat/versions", json={"checklist": invalid})
    assert response.status_code == 400 and "error" in response.json()
    with connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM checklist_versions").fetchone()[0] == 1
        assert connection.execute("SELECT active_version FROM checklist_state").fetchone()[0] == 1


def test_duplicate_set_id_and_unknown_ids(client):
    response = client.post("/api/checklists", json={"id": "chat", "checklist": checklist()})
    assert response.status_code == 409 and response.json() == {"error": "id exists"}
    response = client.post("/api/checklists/missing/versions", json={"checklist": checklist()})
    assert response.status_code == 404 and response.json() == {"error": "checklist not found"}
    response = client.post("/api/checklists/missing/activate", json={})
    assert response.status_code == 404 and response.json() == {"error": "checklist not found"}
    response = client.post("/api/checklists/chat/activate", json={"version": 999})
    assert response.status_code == 404 and response.json() == {"error": "version not found"}


def test_reactivate_old_version_and_assign_channels(client, database):
    saved_evaluation(database)
    client.post("/api/checklists/chat/versions", json={"checklist": checklist()})
    assert client.get("/api/conversations").json()[0]["outdated"] is True
    response = client.post("/api/checklists/chat/activate", json={"version": 1, "channels": ["agent chat", "custom channel"]})
    assert response.status_code == 200 and response.json() == {"ok": True}
    assert client.get("/api/conversations").json()[0]["outdated"] is False
    card = client.get("/api/conversations/synthetic-chat-001").json()
    assert set(card) == {"conversation", "evaluation", "history"}
    assert card["evaluation"]["checklist_version"] == 1 and card["evaluation"]["totals"]["total"] == 90
    response = client.post("/api/checklists", json={"channels": ["custom channel"], "checklist": checklist()})
    new_id = response.json()["id"]
    items = {item["id"]: item for item in client.get("/api/checklists").json()}
    assert items["chat"]["channels"] == ["agent chat"]
    assert items[new_id]["channels"] == ["custom channel"]
    response = client.post(f"/api/checklists/{new_id}/activate", json={"channels": []})
    assert response.status_code == 200
    response = client.post(f"/api/checklists/{new_id}/versions", json={"checklist": checklist()})
    assert response.json() == {"version": 2}
    items = {item["id"]: item for item in client.get("/api/checklists").json()}
    assert items[new_id]["channels"] == [] and items[new_id]["active"] == 2


def test_concurrent_versions_get_distinct_numbers(database):
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: create_version(database, "chat", {"checklist": checklist()}), range(2)))
    assert sorted(result["version"] for result in outcomes) == [2, 3]
    with connect(database) as connection:
        assert connection.execute("SELECT active_version FROM checklist_state").fetchone()[0] == 3
        assert connection.execute("SELECT active_version FROM channel_checklists").fetchone()[0] == 3


def test_version_and_activation_roll_back_together(client, database):
    with connect(database) as connection, connection:
        connection.execute("""CREATE TRIGGER reject_version_metadata BEFORE INSERT ON checklist_version_metadata
            WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'test failure'); END""")
    response = client.post("/api/checklists/chat/versions", json={"checklist": checklist()})
    assert response.status_code == 500 and response.json() == {"error": "Could not save checklist"}
    with connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM checklist_versions").fetchone()[0] == 1
        assert connection.execute("SELECT active_version FROM checklist_state").fetchone()[0] == 1
        assert connection.execute("SELECT active_version FROM channel_checklists").fetchone()[0] == 1


def test_migrate_existing_v1_preserves_versions_and_evaluations(database):
    saved = saved_evaluation(database)
    with connect(database) as connection, connection:
        original = [tuple(row) for row in connection.execute("SELECT * FROM checklist_versions")]
        connection.execute("DROP TABLE checklist_version_metadata")
        connection.execute("DROP TABLE checklist_state")
        connection.execute("PRAGMA user_version = 1")
    migrate(database)
    migrate(database)
    with connect(database) as connection:
        assert original == [tuple(row) for row in connection.execute("SELECT * FROM checklist_versions")]
        assert connection.execute("SELECT id FROM evaluations").fetchone()[0] == saved["id"]
        assert connection.execute("SELECT created_at FROM checklist_version_metadata").fetchone()[0] is None
        assert connection.execute("SELECT COUNT(*) FROM evaluation_results").fetchone()[0] == 8
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2

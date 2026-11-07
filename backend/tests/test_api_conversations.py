import json

from fastapi.testclient import TestClient
import pytest

from backend import evaluations
from backend.database import connect, migrate, seed_demo
from backend.evaluations import load_context, save_evaluation
from main import create_app


CID = "synthetic-chat-001"


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "read.sqlite3"
    migrate(path)
    seed_demo(path)
    return path


@pytest.fixture
def client(database, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Reading conversations must never call the evaluator")

    monkeypatch.setattr(evaluations.evaluator, "evaluate", forbidden)
    monkeypatch.setattr(evaluations.evaluator, "_post", forbidden)
    with TestClient(create_app(database)) as api:
        yield api


def persist(database, failed=False, confidence=None):
    context = load_context(database, CID)
    results = []
    for index, criterion in enumerate(context["checklist"]["criteria"]):
        result = {"criterion_id": criterion["id"], "na": False,
                  "confidence": confidence[index] if confidence and index < len(confidence) else None}
        if criterion["type"] == "scale":
            result["score"] = criterion["scale"]["max"]
        else:
            result["answer"] = "no" if criterion.get("critical_on") == "yes" or (failed and index == 0) else "yes"
        results.append(result)
    return save_evaluation(database, context, {"results": results, "model": "saved-test-model", "cost_usd": 0,
                           "facts": {"synthetic": True}, "problems": [], "trace": {"raw": ["synthetic"]}}, 12)


def test_empty_list(tmp_path):
    with TestClient(create_app(tmp_path / "empty.sqlite3")) as client:
        response = client.get("/api/conversations")
        assert response.status_code == 200 and response.json() == []


def test_unevaluated_list_shape_and_defaults(client):
    response = client.get("/api/conversations")
    assert response.status_code == 200
    assert response.json() == [{
        "conversation_id": CID, "group_id": "SYNTHETIC", "channel": "agent chat", "language": "RU", "lines": 4,
        "total": None, "original_total": None, "critical": [], "checklist_id": None, "checklist_version": None,
        "outdated": False, "low_confidence": 0, "appeals_open": 0, "appeals_total": 0, "evaluated_at": None,
        "model": None, "cost_usd": None, "ms": None, "preview": "Здравствуйте! Где посмотреть тарифы?",
    }]


def test_group_filter_and_preview(client, database):
    with connect(database) as connection, connection:
        conversation = json.loads(connection.execute("SELECT payload FROM conversations").fetchone()[0])
        conversation.update(conversation_id="second", group_id="OTHER", transcript=[
            {"speaker": "operator", "text": "Skip operator"}, {"speaker": "client", "text": "x" * 140}])
        connection.execute("INSERT INTO conversations VALUES (?, ?, ?)",
                           ("second", "agent chat", json.dumps(conversation)))
    assert len(client.get("/api/conversations").json()) == 2
    assert len(client.get("/api/conversations?group=").json()) == 2
    assert client.get("/api/conversations?group=missing").json() == []
    rows = client.get("/api/conversations?group=OTHER").json()
    assert len(rows) == 1 and rows[0]["conversation_id"] == "second" and rows[0]["preview"] == "x" * 120


def test_unevaluated_card(client, database):
    response = client.get(f"/api/conversations/{CID}")
    assert response.status_code == 200
    with connect(database) as connection:
        original = json.loads(connection.execute("SELECT payload FROM conversations").fetchone()[0])
    assert response.json() == {"conversation": original, "evaluation": None, "history": []}


def test_unknown_conversation_matches_reference(client):
    response = client.get("/api/conversations/missing")
    assert response.status_code == 404 and response.json() == {"error": "not found"}


def test_latest_evaluation_and_complete_history(client, database):
    first = persist(database)
    last = persist(database, failed=True)
    response = client.get(f"/api/conversations/{CID}")
    assert response.status_code == 200
    card = response.json()
    assert card["evaluation"] == last
    assert [item["id"] for item in card["history"]] == [first["id"], last["id"]]
    assert [item["total"] for item in card["history"]] == [100, 90]
    assert set(card["history"][0]) == {"id", "created_at", "checklist_id", "checklist_version", "model", "total"}
    row = client.get("/api/conversations").json()[0]
    assert row["total"] == row["original_total"] == 90
    assert row["model"] == "saved-test-model" and row["evaluated_at"] == last["created_at"]
    assert row["ms"] == 12 and row["cost_usd"] == 0 and row["outdated"] is False
    assert "trace" not in row and "results" not in row and "checklist" not in row
    with connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM evaluations").fetchone()[0] == 2


def test_historical_versions_used_for_card_list_and_history(client, database):
    old = persist(database, failed=True)
    with connect(database) as connection, connection:
        checklist = json.loads(connection.execute("SELECT checklist FROM checklist_versions").fetchone()[0])
        for index, criterion in enumerate(checklist["criteria"]):
            criterion["weight"] = 100 if index == 0 else 0
        connection.execute("INSERT INTO checklist_versions VALUES ('chat', 2, ?)", (json.dumps(checklist),))
        connection.execute("UPDATE channel_checklists SET active_version = 2")
    row = client.get("/api/conversations").json()[0]
    assert row["outdated"] is True and row["total"] == 90 and row["checklist_version"] == 1
    card = client.get(f"/api/conversations/{CID}").json()
    assert card["evaluation"] == old
    newest = persist(database, failed=True)
    card = client.get(f"/api/conversations/{CID}").json()
    assert card["evaluation"] == newest and newest["checklist_version"] == 2
    assert [item["total"] for item in card["history"]] == [90, 0]
    row = client.get("/api/conversations").json()[0]
    assert row["outdated"] is False and row["total"] == 0


def test_totals_recomputed_from_stored_criteria(client, database):
    saved = persist(database)
    with connect(database) as connection, connection:
        row = connection.execute("SELECT criterion_id, result FROM evaluation_results ORDER BY position LIMIT 1").fetchone()
        result = {**json.loads(row["result"]), "answer": "no"}
        connection.execute("UPDATE evaluation_results SET result = ? WHERE evaluation_id = ? AND criterion_id = ?",
                           (json.dumps(result), saved["id"], row["criterion_id"]))
    assert client.get("/api/conversations").json()[0]["total"] == 90
    card = client.get(f"/api/conversations/{CID}").json()
    assert card["evaluation"]["totals"]["total"] == 90 and card["history"][0]["total"] == 90
    with connect(database) as connection:
        metadata = json.loads(connection.execute("SELECT metadata FROM evaluations").fetchone()[0])
        assert "totals" not in metadata and "original_totals" not in metadata


def test_low_confidence_threshold_and_critical_flag(client, database):
    saved = persist(database, confidence=[None, 0, 0.66, 0.67])
    with connect(database) as connection, connection:
        row = connection.execute("SELECT criterion_id, result FROM evaluation_results ORDER BY position DESC LIMIT 1").fetchone()
        critical = {**json.loads(row["result"]), "answer": "yes"}
        connection.execute("UPDATE evaluation_results SET result = ? WHERE criterion_id = ?", (json.dumps(critical), row["criterion_id"]))
    card = client.get(f"/api/conversations/{CID}").json()["evaluation"]
    assert card["low_confidence"] == [result["criterion_id"] for result in saved["results"][1:3]]
    row = client.get("/api/conversations").json()[0]
    assert row["low_confidence"] == 2 and row["critical"] == ["c08_gross"]


def test_different_active_checklist_marks_outdated(client, database):
    persist(database)
    with connect(database) as connection, connection:
        checklist = connection.execute("SELECT checklist FROM checklist_versions").fetchone()[0]
        connection.execute("INSERT INTO checklists VALUES ('replacement', 'Replacement')")
        connection.execute("INSERT INTO checklist_versions VALUES ('replacement', 1, ?)", (checklist,))
        connection.execute("UPDATE channel_checklists SET checklist_id = 'replacement'")
    row = client.get("/api/conversations").json()[0]
    assert row["outdated"] is True and row["checklist_id"] == "chat" and row["total"] == 100

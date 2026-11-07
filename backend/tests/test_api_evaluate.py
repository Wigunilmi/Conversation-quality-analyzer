import json
import threading

from fastapi.testclient import TestClient
import pytest

from backend import evaluations
from backend.database import ROOT, connect, migrate, seed_demo
from backend.cqa.scoring import compute_totals
from main import create_app


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "test.sqlite3"
    migrate(path)
    seed_demo(path)
    return path


@pytest.fixture
def client(database):
    with TestClient(create_app(database)) as api:
        yield api


@pytest.fixture
def model(monkeypatch):
    calls = []

    def fake_evaluate(conversation, checklist):
        calls.append((conversation, checklist, threading.get_ident()))
        results = []
        for index, criterion in enumerate(checklist["criteria"]):
            result = {"criterion_id": criterion["id"], "na": False, "evidence_ids": [1],
                      "confidence": [None, 0.66, 0.67][index % 3], "explanation": "Synthetic test"}
            if criterion["type"] == "scale":
                result["score"] = criterion["scale"]["max"]
            else:
                result["answer"] = "no" if criterion.get("critical_on") == "yes" else "yes"
            results.append(result)
        return {"results": results, "problems": [], "facts": {"synthetic": True}, "model": "test-model",
                "votes": 1, "usage": {"prompt_tokens": 10, "completion_tokens": 5}, "cost_usd": 0,
                "prompt_version": "test", "trace": {"raw": ["test"]}}

    monkeypatch.setattr(evaluations.evaluator, "evaluate", fake_evaluate)
    return fake_evaluate, calls


def counts(path):
    with connect(path) as connection:
        return tuple(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                     for table in ("evaluations", "evaluation_results"))


def test_evaluate_view_and_persistence(client, database, model, monkeypatch):
    fake_evaluate, calls = model
    event_loop_threads = []
    run = evaluations.run_in_threadpool

    async def traced_run(function, *args):
        if function is fake_evaluate:
            event_loop_threads.append(threading.get_ident())
        return await run(function, *args)

    monkeypatch.setattr(evaluations, "run_in_threadpool", traced_run)
    response = client.post("/api/evaluate", json={"conversation_id": "synthetic-chat-001"})
    assert response.status_code == 200
    view = response.json()
    assert len(calls) == 1 and event_loop_threads[0] != calls[0][2]
    assert view["conversation_id"] == "synthetic-chat-001" and view["group_id"] == "SYNTHETIC"
    assert view["checklist_id"] == "chat" and view["checklist_version"] == 1
    assert view["checklist_name"] == calls[0][1]["name"]
    assert view["id"].startswith("ev_") and view["created_at"].endswith("Z") and view["ms"] >= 0
    assert view["appeals"] == [] and view["final_results"] == view["results"]
    assert view["totals"] == view["original_totals"] == compute_totals(view["checklist"], view["results"])
    assert view["totals"]["total"] == 100
    assert view["low_confidence"] == [r["criterion_id"] for r in view["results"] if r["confidence"] == 0.66]
    assert view["trace"] == {"raw": ["test"]} and view["model"] == "test-model"
    with connect(database) as connection:
        row = connection.execute("SELECT * FROM evaluations").fetchone()
        assert row["checklist_id"] == "chat" and row["checklist_version"] == 1
        metadata = json.loads(row["metadata"])
        assert not {"results", "totals", "original_totals", "total"}.intersection(metadata)
        assert {column["name"] for column in connection.execute("PRAGMA table_info(evaluations)")} == {
            "id", "conversation_id", "checklist_id", "checklist_version", "metadata"}
        saved = [json.loads(row["result"]) for row in connection.execute(
            "SELECT result FROM evaluation_results ORDER BY position")]
    assert saved == view["results"] and counts(database) == (1, len(saved))


def test_unknown_conversation_matches_reference(client, database, model):
    response = client.post("/api/evaluate", json={"conversation_id": "missing"})
    assert response.status_code == 404
    assert response.json() == {"error": "conversation missing not loaded"}
    assert model[1] == [] and counts(database) == (0, 0)


def test_real_evaluator_pipeline_with_model_transport_stub(client, database, monkeypatch):
    checklist = json.loads((ROOT / "checklists" / "chat.json").read_text(encoding="utf-8"))
    results = []
    for criterion in checklist["criteria"]:
        result = {"criterion_id": criterion["id"], "na": False, "confidence": 0.9, "evidence_ids": [1]}
        if criterion["type"] == "scale":
            result["score"] = criterion["scale"]["max"]
        else:
            result["answer"] = "no" if criterion.get("critical_on") == "yes" else "yes"
        results.append(result)
    prompts = []

    def fake_post(prompt):
        prompts.append(prompt)
        return {"choices": [{"message": {"content": json.dumps({"results": results})}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5}}

    # This placeholder only selects the real evaluator pipeline; the transport is replaced.
    monkeypatch.setenv("LLM_API_KEY", "synthetic-test-placeholder")
    monkeypatch.setenv("LLM_MODEL", "transport-stub")
    monkeypatch.setenv("LLM_VOTES", "1")
    monkeypatch.setenv("LLM_PRICE_IN", "0")
    monkeypatch.setenv("LLM_PRICE_OUT", "0")
    monkeypatch.setattr(evaluations.evaluator, "_post", fake_post)
    response = client.post("/api/evaluate", json={"conversation_id": "synthetic-chat-001"})
    assert response.status_code == 200
    view = response.json()
    assert len(prompts) == 1 and view["model"] == "transport-stub"
    assert view["problems"] == [] and view["totals"]["total"] == 100
    assert view["usage"] == {"prompt_tokens": 10, "completion_tokens": 5}
    assert view["facts"] and view["trace"]["system"] == prompts[0]["system"]
    assert counts(database) == (1, len(results))


def test_model_failure_writes_nothing(client, database, monkeypatch):
    def fail(*args):
        raise RuntimeError("synthetic model failure")

    monkeypatch.setattr(evaluations.evaluator, "evaluate", fail)
    response = client.post("/api/evaluate", json={"conversation_id": "synthetic-chat-001"})
    assert response.status_code == 500 and response.json() == {"error": "synthetic model failure"}
    assert counts(database) == (0, 0)


def test_results_insert_failure_rolls_back_whole_transaction(client, database, model, monkeypatch):
    fake = model[0]

    def duplicate_result(*args):
        output = fake(*args)
        output["results"].append(dict(output["results"][0]))
        return output

    monkeypatch.setattr(evaluations.evaluator, "evaluate", duplicate_result)
    response = client.post("/api/evaluate", json={"conversation_id": "synthetic-chat-001"})
    assert response.status_code == 500
    assert counts(database) == (0, 0)


def test_active_version_is_pinned_before_model_call(client, database, model, monkeypatch):
    with connect(database) as connection, connection:
        checklist = json.loads(connection.execute("SELECT checklist FROM checklist_versions").fetchone()[0])
        checklist["instructions"] = "Version two"
        connection.execute("INSERT INTO checklist_versions VALUES ('chat', 2, ?)", (json.dumps(checklist),))
        connection.execute("UPDATE channel_checklists SET active_version = 2")
    fake = model[0]

    def switch_active(conversation, selected_checklist):
        with connect(database) as connection, connection:
            third = {**checklist, "instructions": "Version three"}
            connection.execute("INSERT INTO checklist_versions VALUES ('chat', 3, ?)", (json.dumps(third),))
            connection.execute("UPDATE channel_checklists SET active_version = 3")
        return fake(conversation, selected_checklist)

    monkeypatch.setattr(evaluations.evaluator, "evaluate", switch_active)
    response = client.post("/api/evaluate", json={"conversation_id": "synthetic-chat-001"})
    assert response.status_code == 200
    assert response.json()["checklist_version"] == 2
    assert response.json()["checklist"]["instructions"] == "Version two"
    assert model[1][0][1]["instructions"] == "Version two"
    with connect(database) as connection:
        assert connection.execute("SELECT checklist_version FROM evaluations").fetchone()[0] == 2


def test_checklist_selected_by_channel(client, database, model):
    call = json.loads((ROOT / "checklists" / "call.json").read_text(encoding="utf-8"))
    with connect(database) as connection, connection:
        connection.execute("INSERT INTO checklists VALUES ('call', ?)", (call["name"],))
        connection.execute("INSERT INTO checklist_versions VALUES ('call', 1, ?)", (json.dumps(call),))
        connection.execute("INSERT INTO channel_checklists VALUES ('voice call', 'call', 1)")
        conversation = json.loads(connection.execute("SELECT payload FROM conversations").fetchone()[0])
        conversation["channel"] = "voice call"
        connection.execute("UPDATE conversations SET channel = 'voice call', payload = ?", (json.dumps(conversation),))
    response = client.post("/api/evaluate", json={"conversation_id": "synthetic-chat-001"})
    assert response.status_code == 200 and response.json()["checklist_id"] == "call"
    assert model[1][0][1] == call


def test_health_unchanged(client):
    response = client.get("/health")
    assert response.status_code == 200 and response.json() == {"status": "ok"}


def test_migration_and_seed_are_repeatable(database):
    migrate(database)
    seed_demo(database)
    with connect(database) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM checklist_versions").fetchone()[0] == 1

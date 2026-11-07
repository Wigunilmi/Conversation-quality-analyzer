from copy import deepcopy
import json
import threading

from fastapi.testclient import TestClient
import pytest

from backend import evaluations
from backend.checklists import create_set, create_version, activate_set
from backend.database import ROOT, connect, migrate, seed_demo
from main import create_app


@pytest.fixture
def batch_env(tmp_path, monkeypatch):
    path = tmp_path / "batch.sqlite3"
    migrate(path)
    seed_demo(path)
    call = json.loads((ROOT / "checklists" / "call.json").read_text(encoding="utf-8"))
    create_set(path, {"id": "call", "channels": ["voice call"], "checklist": call})
    with connect(path) as connection, connection:
        base = json.loads(connection.execute("SELECT payload FROM conversations").fetchone()[0])
        # Allow a legitimate completed all-N/A evaluation with a null total.
        for row in connection.execute("SELECT * FROM checklist_versions").fetchall():
            checklist = json.loads(row["checklist"])
            for criterion in checklist["criteria"]:
                criterion["na_allowed"] = True
            connection.execute("UPDATE checklist_versions SET checklist = ? WHERE checklist_id = ? AND version = ?",
                               (json.dumps(checklist), row["checklist_id"], row["version"]))
        for index in range(14):
            conversation = {**base, "conversation_id": f"batch-{index:03}", "group_id": "BATCH",
                            "channel": "agent chat" if index % 2 == 0 else "voice call"}
            connection.execute("INSERT INTO conversations VALUES (?, ?, ?)",
                               (conversation["conversation_id"], conversation["channel"], json.dumps(conversation)))
    monkeypatch.delenv("LLM_CONCURRENCY", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    lock = threading.Lock()
    gate = threading.Event()
    state = {"expected": 4, "active": 0, "peak": 0, "calls": [], "fail": set()}

    def fake_evaluate(conversation, checklist):
        cid = conversation["conversation_id"]
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
            state["calls"].append((cid, checklist.get("batch_version", 1)))
            callback = state.pop("on_first_call", None)
            if state["active"] >= state["expected"]:
                gate.set()
        try:
            if callback:
                callback()
            assert gate.wait(5), "Expected batch concurrency was not reached"
            if cid in state["fail"]:
                raise RuntimeError("synthetic model failure")
            results = []
            for criterion in checklist["criteria"]:
                result = {"criterion_id": criterion["id"], "na": cid == "batch-000", "confidence": 0.9}
                if not result["na"]:
                    if criterion["type"] == "scale":
                        result["score"] = criterion["scale"]["max"]
                    else:
                        result["answer"] = "no" if criterion.get("critical_on") == "yes" else "yes"
                results.append(result)
            return {"results": results, "model": "BATCH-STUB", "cost_usd": 0.0011}
        finally:
            with lock:
                state["active"] -= 1

    def forbidden(*args, **kwargs):
        raise AssertionError("Real model transport is forbidden")

    monkeypatch.setattr(evaluations.evaluator, "evaluate", fake_evaluate)
    monkeypatch.setattr(evaluations.evaluator, "_post", forbidden)
    with TestClient(create_app(path)) as client:
        yield client, path, state


def activate_next_versions(path):
    with connect(path) as connection:
        checklists = [(row["checklist_id"], json.loads(row["checklist"]))
                      for row in connection.execute("SELECT * FROM checklist_versions WHERE version = 1")]
    for identifier, checklist in checklists:
        changed = deepcopy(checklist)
        changed["batch_version"] = 2
        assert create_version(path, identifier, {"checklist": changed}) == {"version": 2}


def evaluation_count(path):
    with connect(path) as connection:
        return connection.execute("SELECT COUNT(*) FROM evaluations").fetchone()[0]


def test_whole_group_partial_failure_retry_and_null_completion(batch_env):
    client, path, state = batch_env
    state["fail"] = {"batch-005"}
    response = client.post("/api/evaluate-batch", json={"group_id": "BATCH"})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"count", "ms", "cost_usd", "results"}
    assert body["count"] == 14 and len(body["results"]) == 14 and body["ms"] >= 0
    assert body["cost_usd"] == 0.0143 and state["peak"] == 4
    assert [result["cid"] for result in body["results"]] == [f"batch-{index:03}" for index in range(14)]
    assert body["results"][0]["ok"] is True and body["results"][0]["total"] is None
    assert body["results"][5] == {"ok": False, "cid": "batch-005", "error": "synthetic model failure"}
    assert evaluation_count(path) == 13
    state["fail"].clear()
    response = client.post("/api/evaluate-batch", json={"group_id": "BATCH", "only_missing": True})
    assert response.status_code == 200 and response.json()["count"] == 1
    assert response.json()["results"][0]["cid"] == "batch-005" and evaluation_count(path) == 14
    previous_calls = len(state["calls"])
    skipped = client.post("/api/evaluate-batch", json={"group_id": "BATCH", "only_missing": True}).json()
    assert skipped["count"] == 0 and skipped["results"] == [] and skipped["cost_usd"] == 0
    assert len(state["calls"]) == previous_calls  # Includes the completed null-total conversation.
    assert client.post("/api/evaluate-batch", json={"group_id": "BATCH", "only_missing": False}).json()["count"] == 14
    assert evaluation_count(path) == 28


def test_channel_versions_pinned_at_start_then_new_version_re_evaluated(batch_env):
    client, path, state = batch_env
    state["on_first_call"] = lambda: activate_next_versions(path)
    response = client.post("/api/evaluate-batch", json={"group_id": "BATCH", "only_missing": True})
    assert response.status_code == 200 and response.json()["count"] == 14
    assert all(item["ok"] for item in response.json()["results"])
    assert {version for _, version in state["calls"]} == {1}
    with connect(path) as connection:
        assert {row[0] for row in connection.execute("SELECT checklist_version FROM evaluations")} == {1}
        assert {row[0] for row in connection.execute("SELECT active_version FROM channel_checklists")} == {2}
        assert {row[0] for row in connection.execute("SELECT checklist_id FROM evaluations")} == {"chat", "call"}
    state["calls"].clear()
    second = client.post("/api/evaluate-batch", json={"group_id": "BATCH", "only_missing": True})
    assert second.status_code == 200 and second.json()["count"] == 14
    assert {version for _, version in state["calls"]} == {2} and evaluation_count(path) == 28
    assert client.post("/api/evaluate-batch", json={"group_id": "BATCH", "only_missing": True}).json()["count"] == 0
    activate_set(path, "chat", {"version": 1})
    activate_set(path, "call", {"version": 1})
    # An older completed evaluation of the selected version still satisfies only_missing.
    assert client.post("/api/evaluate-batch", json={"group_id": "BATCH", "only_missing": True}).json()["count"] == 0


@pytest.mark.parametrize("requested, expected", [(None, 2), (3, 3)])
def test_environment_concurrency_and_body_override(batch_env, monkeypatch, requested, expected):
    client, path, state = batch_env
    monkeypatch.setenv("LLM_CONCURRENCY", "2")
    state["expected"] = expected
    body = {"group_id": "BATCH"}
    if requested is not None:
        body["concurrency"] = requested
    response = client.post("/api/evaluate-batch", json=body)
    assert response.status_code == 200 and all(result["ok"] for result in response.json()["results"])
    assert state["peak"] == expected and evaluation_count(path) == 14


def test_omitted_group_includes_all_groups(batch_env):
    client, path, state = batch_env
    response = client.post("/api/evaluate-batch", json={})
    assert response.status_code == 200 and response.json()["count"] == 15
    assert evaluation_count(path) == 15
    assert any(cid == "synthetic-chat-001" for cid, _ in state["calls"])


def test_empty_group_never_calls_model(batch_env):
    client, path, state = batch_env
    response = client.post("/api/evaluate-batch", json={"group_id": "empty"})
    assert response.status_code == 200 and response.json()["count"] == 0
    assert response.json()["results"] == [] and state["calls"] == [] and evaluation_count(path) == 0


def test_database_failure_isolated_to_one_conversation(batch_env):
    client, path, state = batch_env
    with connect(path) as connection, connection:
        connection.execute("""CREATE TRIGGER reject_one BEFORE INSERT ON evaluations
            WHEN NEW.conversation_id = 'batch-005' BEGIN SELECT RAISE(ABORT, 'synthetic save failure'); END""")
    response = client.post("/api/evaluate-batch", json={"group_id": "BATCH"})
    assert response.status_code == 200
    assert sum(result["ok"] for result in response.json()["results"]) == 13
    assert evaluation_count(path) == 13
    with connect(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM evaluation_results").fetchone()[0] == 13 * 8


def test_missing_checklist_is_per_conversation_failure(batch_env):
    client, path, state = batch_env
    with connect(path) as connection, connection:
        connection.execute("DELETE FROM channel_checklists WHERE channel = 'voice call'")
    response = client.post("/api/evaluate-batch", json={"group_id": "BATCH"})
    assert response.status_code == 200
    assert sum(result["ok"] for result in response.json()["results"]) == 7
    assert len(state["calls"]) == 7 and evaluation_count(path) == 7


@pytest.mark.parametrize("environment, requested, expected_status", [("0", None, 400), ("bad", None, 400), ("4", 0, 422), ("4", -1, 422)])
def test_invalid_concurrency_does_not_run_model(batch_env, monkeypatch, environment, requested, expected_status):
    client, path, state = batch_env
    monkeypatch.setenv("LLM_CONCURRENCY", environment)
    body = {"group_id": "BATCH"}
    if requested is not None:
        body["concurrency"] = requested
    assert client.post("/api/evaluate-batch", json=body).status_code == expected_status
    assert state["calls"] == [] and evaluation_count(path) == 0

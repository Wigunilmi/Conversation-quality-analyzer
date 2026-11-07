from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json

from fastapi.testclient import TestClient
import pytest

from backend import evaluations
from backend.appeals import AppealError, create_appeal, decide_appeal
from backend.checklists import create_version
from backend.cqa.scoring import compute_totals
from backend.database import connect, migrate, seed_demo
from backend.evaluations import load_context, save_evaluation
from main import create_app


CID = "synthetic-chat-001"


@pytest.fixture
def scenario(tmp_path, monkeypatch):
    path = tmp_path / "appeals.sqlite3"
    migrate(path)
    seed_demo(path)

    def forbidden(*args, **kwargs):
        raise AssertionError("Appeals must not call the model")

    monkeypatch.setattr(evaluations.evaluator, "evaluate", forbidden)
    monkeypatch.setattr(evaluations.evaluator, "_post", forbidden)
    context = load_context(path, CID)
    results = []
    for index, criterion in enumerate(context["checklist"]["criteria"]):
        result = {"criterion_id": criterion["id"], "na": False, "confidence": 0.6 if index == 0 else 0.9}
        if criterion["type"] == "scale":
            result["score"] = criterion["scale"]["max"]
        else:
            result["answer"] = "no" if index == 0 or criterion.get("critical_on") == "yes" else "yes"
        results.append(result)
    original = save_evaluation(path, context, {"results": results, "model": "saved-fixture"}, 1)
    with TestClient(create_app(path)) as client:
        yield client, path, original


def open_appeal(client, evaluation, criterion="c01_contact"):
    response = client.post("/api/appeals", json={"evaluation_id": evaluation["id"], "criterion_id": criterion,
                                               "comment": "  Please review  "})
    assert response.status_code == 200
    return response.json()


def test_change_full_scenario_uses_historical_checklist_and_preserves_original(scenario):
    client, path, original = scenario
    assert original["totals"]["total"] == 90
    appeal = open_appeal(client, original)
    assert appeal["comment"] == "Please review" and appeal["author"] == "Оператор"
    assert appeal["status"] == "open" and "decision" not in appeal
    assert appeal["evaluation_id"] == original["id"] and appeal["criterion_id"] == "c01_contact"
    assert appeal["original"] == original["results"][0]
    assert client.get("/api/conversations").json()[0]["appeals_open"] == 1
    active = deepcopy(original["checklist"])
    for index, criterion in enumerate(active["criteria"]):
        criterion["weight"] = 100 if index == 0 else 0
    create_version(path, "chat", {"checklist": active})
    response = client.post(f"/api/appeals/{appeal['id']}/decide", json={
        "action": "change", "answer": "yes", "reason": "  Greeting confirmed  ", "reviewer": "QA"})
    assert response.status_code == 200
    decision = response.json()
    assert decision["appeal"]["status"] == "changed"
    assert decision["appeal"]["decision"]["reason"] == "Greeting confirmed"
    assert decision["appeal"]["decision"]["reviewer"] == "QA"
    assert decision["appeal"]["decision"]["decided_at"].endswith("Z")
    view = decision["evaluation"]
    assert view["original_totals"]["total"] == 90 and view["totals"]["total"] == 100
    assert view["checklist_version"] == 1 and view["results"] == original["results"]
    assert view["final_results"][0]["answer"] == "yes"
    assert view["final_results"][0]["overridden"] is True and view["final_results"][0]["appeal_id"] == appeal["id"]
    assert view["low_confidence"] == original["low_confidence"]
    card = client.get(f"/api/conversations/{CID}").json()
    assert set(card) == {"conversation", "evaluation", "history"} and card["evaluation"] == view
    assert card["history"][0]["total"] == 100
    row = client.get("/api/conversations").json()[0]
    assert (row["original_total"], row["total"], row["appeals_open"], row["appeals_total"]) == (90, 100, 0, 1)
    assert row["outdated"] is True
    listed = client.get("/api/appeals?status=changed").json()
    assert listed == [{**decision["appeal"], "conversation_id": CID}]
    with connect(path) as connection:
        raw = json.loads(connection.execute("SELECT result FROM evaluation_results ORDER BY position LIMIT 1").fetchone()[0])
        assert raw == original["results"][0]
        metadata = json.loads(connection.execute("SELECT metadata FROM evaluations").fetchone()[0])
        assert not {"totals", "original_totals", "final_results"}.intersection(metadata)
        assert connection.execute("SELECT COUNT(*) FROM evaluations").fetchone()[0] == 1


def test_rejected_appeal_saves_reason_and_keeps_score(scenario):
    client, path, original = scenario
    appeal = open_appeal(client, original)
    response = client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "uphold", "reason": "  Original is correct  "})
    assert response.status_code == 200
    decided = response.json()["appeal"]
    assert decided["status"] == "upheld" and decided["original"] == appeal["original"]
    assert decided["decision"]["reason"] == "Original is correct"
    assert decided["decision"]["reviewer"] == "Проверяющий" and "result" not in decided["decision"]
    view = client.get(f"/api/conversations/{CID}").json()["evaluation"]
    assert view["original_totals"] == view["totals"] == original["totals"]
    assert view["results"] == view["final_results"] == original["results"]
    assert view["appeals"] == [decided]
    row = client.get("/api/conversations").json()[0]
    assert row["original_total"] == row["total"] == 90 and row["appeals_open"] == 0 and row["appeals_total"] == 1
    assert client.get("/api/appeals?status=upheld").json() == [{**decided, "conversation_id": CID}]
    with connect(path) as connection:
        stored = json.loads(connection.execute("SELECT decision FROM appeals").fetchone()[0])
        assert stored == decided["decision"]


@pytest.mark.parametrize("criterion, correction", [
    ("c04_consultation", {"score": 15}),
    ("c03_identification", {"na": True}),
    ("c08_gross", {"answer": "yes"}),
])
def test_scale_na_and_critical_corrections(scenario, criterion, correction):
    client, path, original = scenario
    appeal = open_appeal(client, original, criterion)
    response = client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "change", "reason": "Checked", **correction})
    assert response.status_code == 200
    view = response.json()["evaluation"]
    final = next(result for result in view["final_results"] if result["criterion_id"] == criterion)
    assert all(final[key] == value for key, value in correction.items())
    if correction.get("na"):
        assert final["na_reason"] == "Checked"
    assert view["totals"] == compute_totals(original["checklist"], view["final_results"])
    assert view["original_totals"] == original["totals"]
    row = client.get("/api/conversations").json()[0]
    assert row["total"] == view["totals"]["total"] and row["critical"] == view["totals"]["critical_errors"]


def test_list_newest_first_and_status_filter(scenario):
    client, path, original = scenario
    first = open_appeal(client, original)
    second = open_appeal(client, original, "c04_consultation")
    assert [item["id"] for item in client.get("/api/appeals").json()] == [second["id"], first["id"]]
    assert client.get("/api/appeals?status=changed").json() == []
    assert len(client.get("/api/appeals?status=open").json()) == 2


def test_duplicate_open_and_repeat_decision_conflicts(scenario):
    client, path, original = scenario
    appeal = open_appeal(client, original)
    response = client.post("/api/appeals", json={"evaluation_id": original["id"], "criterion_id": "c01_contact", "comment": "Again"})
    assert response.status_code == 409 and response.json() == {"error": "appeal already open"}
    client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "uphold", "reason": "Checked"})
    response = client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "change", "answer": "yes", "reason": "Again"})
    assert response.status_code == 409 and response.json() == {"error": "appeal already decided"}
    assert open_appeal(client, original)["id"] != appeal["id"]


@pytest.mark.parametrize("patch, status, error", [
    ({"evaluation_id": "missing"}, 404, "evaluation not found"),
    ({"criterion_id": "missing"}, 400, "unknown criterion"),
    ({"comment": "  "}, 400, "comment is required"),
])
def test_invalid_creation(scenario, patch, status, error):
    client, path, original = scenario
    body = {"evaluation_id": original["id"], "criterion_id": "c01_contact", "comment": "Review", **patch}
    response = client.post("/api/appeals", json=body)
    assert response.status_code == status and response.json() == {"error": error}
    assert client.get("/api/appeals").json() == []


@pytest.mark.parametrize("body, error", [
    ({"action": "change", "answer": "yes"}, "reason is required"),
    ({"action": "wrong", "reason": "Checked"}, "action must be uphold or change"),
    ({"action": "change", "score": "bad", "reason": "Checked"}, "score must be a finite number"),
])
def test_invalid_decision_leaves_appeal_open(scenario, body, error):
    client, path, original = scenario
    appeal = open_appeal(client, original)
    response = client.post(f"/api/appeals/{appeal['id']}/decide", json=body)
    assert response.status_code == 400 and response.json() == {"error": error}
    assert client.get("/api/appeals?status=open").json()[0]["status"] == "open"
    assert client.get(f"/api/conversations/{CID}").json()["evaluation"]["totals"] == original["totals"]


def test_unknown_appeal(scenario):
    client, path, original = scenario
    response = client.post("/api/appeals/missing/decide", json={"action": "uphold", "reason": "Checked"})
    assert response.status_code == 404 and response.json() == {"error": "appeal not found"}


@pytest.mark.parametrize("operation", ["create", "decide"])
def test_concurrent_conflicts(scenario, operation):
    client, path, original = scenario
    if operation == "create":
        function = lambda: create_appeal(path, {"evaluation_id": original["id"], "criterion_id": "c01_contact", "comment": "Review"})
    else:
        appeal = open_appeal(client, original)
        function = lambda: decide_appeal(path, appeal["id"], {"action": "uphold", "reason": "Checked"})

    def attempt(_):
        try:
            function()
            return 200
        except AppealError as exc:
            return exc.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, range(2))) == [200, 409]


def test_decision_failure_rolls_back_status_and_reason(scenario):
    client, path, original = scenario
    appeal = open_appeal(client, original)
    with connect(path) as connection, connection:
        connection.execute("CREATE TRIGGER fail_decision BEFORE UPDATE ON appeals BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    response = client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "change", "answer": "yes", "reason": "Checked"})
    assert response.status_code == 500
    stored = client.get("/api/appeals").json()[0]
    assert stored["status"] == "open" and "decision" not in stored
    assert client.get(f"/api/conversations/{CID}").json()["evaluation"]["totals"] == original["totals"]


def test_migration_preserves_existing_evaluation(scenario):
    client, path, original = scenario
    with connect(path) as connection, connection:
        connection.execute("DROP TABLE appeals")
        connection.execute("PRAGMA user_version = 2")
    migrate(path)
    migrate(path)
    card = client.get(f"/api/conversations/{CID}").json()
    assert card["evaluation"] == original
    assert open_appeal(client, original)["status"] == "open"


def test_appeal_changes_only_its_linked_evaluation(scenario):
    client, path, original = scenario
    context = load_context(path, CID)
    newest = save_evaluation(path, context, {"results": original["results"], "model": "newer-fixture"}, 1)
    appeal = open_appeal(client, original)
    response = client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "change", "answer": "yes", "reason": "Checked"})
    assert response.json()["evaluation"]["id"] == original["id"]
    card = client.get(f"/api/conversations/{CID}").json()
    assert card["evaluation"] == newest
    assert [item["total"] for item in card["history"]] == [100, 90]
    row = client.get("/api/conversations").json()[0]
    assert row["total"] == row["original_total"] == 90 and row["appeals_total"] == 0

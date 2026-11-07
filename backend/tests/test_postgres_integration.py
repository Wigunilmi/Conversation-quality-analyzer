"""Run only against an explicitly supplied TEST_DATABASE_URL; each test owns a fresh schema."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest

from backend import evaluations
from backend.checklists import create_version
from backend.database import connect, seed_demo
from backend.migrate_postgres import migrate_postgres
from backend.postgres import PostgresDatabase
from main import create_app


@pytest.fixture
def postgres(monkeypatch):
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL is not configured")
    import psycopg
    from psycopg import sql

    schema = "cqa_test_" + uuid4().hex
    # Unique test-only schema; never reset or drop public/application tables.
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    target = PostgresDatabase(url, schema)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("API_AUTH_TOKEN", raising=False)
    try:
        migrate_postgres(target)
        migrate_postgres(target)
        seed_demo(target)
        yield target
    finally:
        with psycopg.connect(url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def stub_model(conversation, checklist):
    results = []
    for index, criterion in enumerate(checklist["criteria"]):
        result = {"criterion_id": criterion["id"], "na": False, "confidence": 0.9}
        if criterion["type"] == "scale":
            result["score"] = criterion["scale"]["max"]
        else:
            result["answer"] = "no" if index == 0 or criterion.get("critical_on") == "yes" else "yes"
        results.append(result)
    return {"results": results, "model": "postgres-test-stub", "cost_usd": 0}


def test_postgres_group_evaluation_version_and_appeal(postgres, monkeypatch):
    monkeypatch.setenv("CQA_API_URL", "https://organizers.example/test")
    monkeypatch.setattr(evaluations.evaluator, "evaluate", stub_model)
    with connect(postgres) as connection:
        conversation = json.loads(connection.execute("SELECT payload FROM conversations").fetchone()[0])
    conversation["conversation_id"] = "pg-import-001"
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"isSuccess": True, "data": {"records": [conversation]}}))
    with TestClient(create_app(postgres, organizers_transport=transport)) as client:
        for _ in range(2):
            response = client.post("/api/groups/PG-TEST/load")
            assert response.status_code == 200 and response.json() == {"loaded": 1}
        assert len(client.get("/api/conversations?group=PG-TEST").json()) == 1
        response = client.post("/api/evaluate", json={"conversation_id": "pg-import-001"})
        assert response.status_code == 200
        view = response.json()
        assert view["totals"]["total"] == 90 and len(view["results"]) == 8
        changed = deepcopy(view["checklist"])
        for index, criterion in enumerate(changed["criteria"]):
            criterion["weight"] = 100 if index == 0 else 0
        response = client.post("/api/checklists/chat/versions", json={"checklist": changed, "note": "PG test"})
        assert response.status_code == 200 and response.json() == {"version": 2}
        assert client.get("/api/conversations?group=PG-TEST").json()[0]["outdated"] is True
        response = client.post("/api/appeals", json={"evaluation_id": view["id"], "criterion_id": "c01_contact", "comment": "PG test"})
        assert response.status_code == 200
        appeal = response.json()
        response = client.post("/api/appeals/" + appeal["id"] + "/decide", json={"action": "change", "answer": "yes", "reason": "PG test decision"})
        assert response.status_code == 200
        card = client.get("/api/conversations/pg-import-001").json()
        assert card["evaluation"]["original_totals"]["total"] == 90
        assert card["evaluation"]["totals"]["total"] == 100 and card["evaluation"]["checklist_version"] == 1
        row = client.get("/api/conversations?group=PG-TEST").json()[0]
        assert row["original_total"] == 90 and row["total"] == 100 and row["appeals_total"] == 1
        assert len(client.get("/api/appeals?status=changed").json()) == 1
    with connect(postgres) as connection:
        assert connection.execute("SELECT COUNT(*) FROM evaluation_results").fetchone()[0] == 8
        assert connection.execute("SELECT COUNT(*) FROM evaluations").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 2


def test_postgres_concurrent_versions(postgres):
    with connect(postgres) as connection:
        checklist = json.loads(connection.execute("SELECT checklist FROM checklist_versions").fetchone()[0])
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: create_version(postgres, "chat", {"checklist": checklist}), range(2)))
    assert sorted(result["version"] for result in results) == [2, 3]


def test_postgres_evaluation_rollback(postgres, monkeypatch):
    def duplicate(conversation, checklist):
        output = stub_model(conversation, checklist)
        output["results"].append(output["results"][0])
        return output

    monkeypatch.setattr(evaluations.evaluator, "evaluate", duplicate)
    with TestClient(create_app(postgres)) as client:
        assert client.post("/api/evaluate", json={"conversation_id": "synthetic-chat-001"}).status_code == 500
    with connect(postgres) as connection:
        assert connection.execute("SELECT COUNT(*) FROM evaluations").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM evaluation_results").fetchone()[0] == 0

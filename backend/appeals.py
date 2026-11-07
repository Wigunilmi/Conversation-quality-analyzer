"""Appeal creation, review and decisions without changing model results."""

from datetime import datetime, timezone
import json
import math
from uuid import uuid4

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .database import connect
from .evaluations import appeal_view, evaluation_view


router = APIRouter()


class AppealError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def required_text(body, name):
    value = body.get(name)
    if not isinstance(value, str) or not value.strip():
        raise AppealError(400, f"{name} is required")
    return value.strip()


def list_appeals(path, status=None):
    with connect(path) as connection:
        rows = connection.execute("""SELECT a.*, e.conversation_id FROM appeals a
            JOIN evaluations e ON e.id = a.evaluation_id
            WHERE (? IS NULL OR ? = '' OR a.status = ?) ORDER BY a.rowid DESC""", (status, status, status))
        return [{**appeal_view(row), "conversation_id": row["conversation_id"]} for row in rows]


def create_appeal(path, body):
    with connect(path) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        evaluation_id = body.get("evaluation_id")
        if not connection.execute("SELECT 1 FROM evaluations WHERE id = ?", (evaluation_id,)).fetchone():
            raise AppealError(404, "evaluation not found")
        original = connection.execute("SELECT result FROM evaluation_results WHERE evaluation_id = ? AND criterion_id = ?",
                                      (evaluation_id, body.get("criterion_id"))).fetchone()
        if original is None:
            raise AppealError(400, "unknown criterion")
        comment = required_text(body, "comment")
        if connection.execute("SELECT 1 FROM appeals WHERE evaluation_id = ? AND criterion_id = ? AND status = 'open'",
                              (evaluation_id, body["criterion_id"])).fetchone():
            raise AppealError(409, "appeal already open")
        author = body.get("author") or "Оператор"
        if not isinstance(author, str):
            raise AppealError(400, "author must be a string")
        identifier = "ap_" + uuid4().hex
        connection.execute("""INSERT INTO appeals
            (id, evaluation_id, criterion_id, comment, author, status, created_at, original)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?)""",
            (identifier, evaluation_id, body["criterion_id"], comment, author, now_iso(), original["result"]))
        return appeal_view(connection.execute("SELECT * FROM appeals WHERE id = ?", (identifier,)).fetchone())


def decide_appeal(path, appeal_id, body):
    with connect(path) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM appeals WHERE id = ?", (appeal_id,)).fetchone()
        if row is None:
            raise AppealError(404, "appeal not found")
        if row["status"] != "open":
            raise AppealError(409, "appeal already decided")
        reason = required_text(body, "reason")
        action = body.get("action")
        if action not in ("uphold", "change"):
            raise AppealError(400, "action must be uphold or change")
        reviewer = body.get("reviewer") or "Проверяющий"
        if not isinstance(reviewer, str):
            raise AppealError(400, "reviewer must be a string")
        decision = {"reason": reason, "reviewer": reviewer, "decided_at": now_iso()}
        if action == "change":
            na = bool(body.get("na"))
            result = {"na": na, "na_reason": reason if na else ""}
            if not na and "score" in body:
                try:
                    score = float(body["score"])
                    if not math.isfinite(score):
                        raise ValueError
                except (TypeError, ValueError):
                    raise AppealError(400, "score must be a finite number") from None
                result["score"] = score
            if not na and body.get("answer"):
                result["answer"] = body["answer"]
            decision["result"] = result
        connection.execute("UPDATE appeals SET status = ?, decision = ? WHERE id = ?",
                           ("changed" if action == "change" else "upheld", json.dumps(decision, ensure_ascii=False), appeal_id))
        updated = connection.execute("SELECT * FROM appeals WHERE id = ?", (appeal_id,)).fetchone()
        evaluation = connection.execute("SELECT * FROM evaluations WHERE id = ?", (row["evaluation_id"],)).fetchone()
        return {"appeal": appeal_view(updated), "evaluation": evaluation_view(connection, evaluation)}


async def write_response(function, request, *args):
    try:
        return await run_in_threadpool(function, request.app.state.database_path, *args)
    except AppealError as exc:
        return JSONResponse(status_code=exc.status, content={"error": str(exc)})
    except Exception:
        return JSONResponse(status_code=500, content={"error": "Could not save appeal"})


@router.get("/api/appeals")
async def get_appeals(request: Request, status: str | None = None):
    return await run_in_threadpool(list_appeals, request.app.state.database_path, status)


@router.post("/api/appeals")
async def post_appeal(body: dict, request: Request):
    return await write_response(create_appeal, request, body)


@router.post("/api/appeals/{appeal_id}/decide")
async def post_decision(appeal_id: str, body: dict, request: Request):
    return await write_response(decide_appeal, request, appeal_id, body)

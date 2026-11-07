"""Conversation list and cards built solely from persisted data."""

import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .database import connect
from .evaluations import evaluation_view


router = APIRouter()


def list_conversations(path, group=None):
    with connect(path) as connection, connection:
        connection.execute("BEGIN")  # One consistent read snapshot for rows, results and versions.
        latest = {row["conversation_id"]: row for row in connection.execute(
            """SELECT e.* FROM evaluations e JOIN
               (SELECT conversation_id, MAX(rowid) AS last_row FROM evaluations GROUP BY conversation_id) latest
               ON e.rowid = latest.last_row""")}
        active = {row["channel"]: (row["checklist_id"], row["active_version"])
                  for row in connection.execute("SELECT * FROM channel_checklists")}
        items = []
        for row in connection.execute("SELECT * FROM conversations ORDER BY rowid"):
            conversation = json.loads(row["payload"])
            if group and conversation.get("group_id") != group:
                continue
            evaluation = latest.get(row["id"])
            view = evaluation_view(connection, evaluation) if evaluation is not None else None
            transcript = conversation.get("transcript", [])
            preview = next((line.get("text") or "" for line in transcript if line.get("speaker") == "client"), "")
            items.append({
                "conversation_id": row["id"], "group_id": conversation.get("group_id"),
                "channel": conversation.get("channel"), "language": conversation.get("language"),
                "lines": len(transcript), "total": view["totals"]["total"] if view else None,
                "original_total": view["original_totals"]["total"] if view else None,
                "critical": view["totals"]["critical_errors"] if view else [],
                "checklist_id": view["checklist_id"] if view else None,
                "checklist_version": view["checklist_version"] if view else None,
                "outdated": view is not None and (view["checklist_id"], view["checklist_version"]) != active.get(row["channel"]),
                "low_confidence": len(view["low_confidence"]) if view else 0,
                "appeals_open": 0, "appeals_total": 0,
                "evaluated_at": view["created_at"] if view else None,
                "model": view.get("model") if view else None,
                "cost_usd": view.get("cost_usd") if view else None,
                "ms": view.get("ms") if view else None, "preview": preview[:120],
            })
    return items


def conversation_card(path, conversation_id):
    with connect(path) as connection, connection:
        connection.execute("BEGIN")
        row = connection.execute("SELECT payload FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        if row is None:
            return None
        evaluations = connection.execute(
            "SELECT * FROM evaluations WHERE conversation_id = ? ORDER BY rowid", (conversation_id,),
        ).fetchall()
        views = [evaluation_view(connection, evaluation) for evaluation in evaluations]
        history = [{"id": view["id"], "created_at": view["created_at"], "checklist_id": view["checklist_id"],
                    "checklist_version": view["checklist_version"], "model": view.get("model"),
                    "total": view["totals"]["total"]} for view in views]
        conversation = json.loads(row["payload"])
        return {"conversation": conversation, "evaluation": views[-1] if views else None,
                "history": history}


@router.get("/api/conversations")
async def get_conversations(request: Request, group: str | None = None):
    return await run_in_threadpool(list_conversations, request.app.state.database_path, group)


@router.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, request: Request):
    card = await run_in_threadpool(conversation_card, request.app.state.database_path, conversation_id)
    if card is None:
        return JSONResponse(status_code=404, content={"error": "not found"})
    return card

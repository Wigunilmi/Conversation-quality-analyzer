"""Persist individual evaluations; derive the API View from criterion results."""

from datetime import datetime, timezone
import json
from time import perf_counter
from uuid import uuid4

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .cqa import evaluator
from .cqa.scoring import compute_totals
from .database import connect


router = APIRouter()


class EvaluateRequest(BaseModel):
    conversation_id: str


def load_context(path, conversation_id):
    with connect(path) as connection:
        row = connection.execute(
            """SELECT c.payload, s.id AS checklist_id, s.name, v.version, v.checklist
               FROM conversations c
               LEFT JOIN channel_checklists cc ON cc.channel = c.channel
               LEFT JOIN checklists s ON s.id = cc.checklist_id
               LEFT JOIN checklist_versions v
                 ON v.checklist_id = cc.checklist_id AND v.version = cc.active_version
               WHERE c.id = ?""", (conversation_id,),
        ).fetchone()
    if row is None:
        return None
    if row["checklist"] is None:
        raise RuntimeError("No active checklist for conversation channel")
    return {"conversation": json.loads(row["payload"]), "checklist_id": row["checklist_id"],
            "checklist_name": row["name"], "checklist_version": row["version"],
            "checklist": json.loads(row["checklist"])}


def appeal_view(row):
    appeal = {key: row[key] for key in ("id", "evaluation_id", "criterion_id", "comment", "author", "status", "created_at")}
    appeal["original"] = json.loads(row["original"])
    if row["decision"] is not None:
        appeal["decision"] = json.loads(row["decision"])
    return appeal


def evaluation_view(connection, row):
    """Read stored criteria and their historical checklist; never use the active version."""
    evaluation = json.loads(row["metadata"])
    results = [json.loads(result["result"]) for result in connection.execute(
        "SELECT result FROM evaluation_results WHERE evaluation_id = ? ORDER BY position", (row["id"],))]
    checklist = json.loads(connection.execute(
        "SELECT checklist FROM checklist_versions WHERE checklist_id = ? AND version = ?",
        (row["checklist_id"], row["checklist_version"]),
    ).fetchone()["checklist"])
    appeals = [appeal_view(appeal) for appeal in connection.execute(
        "SELECT * FROM appeals WHERE evaluation_id = ? ORDER BY rowid", (row["id"],))]
    # Match the reference View: the first changed appeal for each criterion supplies its override.
    changes = {}
    for appeal in appeals:
        if appeal["status"] == "changed":
            changes.setdefault(appeal["criterion_id"], appeal)
    final_results = []
    for result in results:
        appeal = changes.get(result["criterion_id"])
        final_results.append({**result, **appeal["decision"]["result"], "overridden": True, "appeal_id": appeal["id"]}
                             if appeal else dict(result))
    return {**evaluation, "results": results, "appeals": appeals, "final_results": final_results,
            "totals": compute_totals(checklist, final_results), "original_totals": compute_totals(checklist, results),
            "checklist": checklist, "low_confidence": [result["criterion_id"] for result in results
                if result.get("confidence") is not None and result["confidence"] < 0.67]}


def save_evaluation(path, context, output, elapsed_ms):
    conversation = context["conversation"]
    evaluation = {
        **{key: value for key, value in output.items() if key not in {"results", "totals", "original_totals"}},
        "id": "ev_" + uuid4().hex,
        "conversation_id": conversation["conversation_id"],
        "group_id": conversation.get("group_id"),
        "checklist_id": context["checklist_id"],
        "checklist_name": context["checklist_name"],
        "checklist_version": context["checklist_version"],
        "created_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "ms": elapsed_ms,
    }
    with connect(path) as connection, connection:
        connection.execute("INSERT INTO evaluations (id, conversation_id, checklist_id, checklist_version, metadata) VALUES (?, ?, ?, ?, ?)",
                           (evaluation["id"], evaluation["conversation_id"], evaluation["checklist_id"],
                            evaluation["checklist_version"], json.dumps(evaluation, ensure_ascii=False)))
        for position, result in enumerate(output["results"]):
            connection.execute("INSERT INTO evaluation_results VALUES (?, ?, ?, ?)",
                               (evaluation["id"], result["criterion_id"], position, json.dumps(result, ensure_ascii=False)))
        row = connection.execute("SELECT * FROM evaluations WHERE id = ?", (evaluation["id"],)).fetchone()
        view = evaluation_view(connection, row)
    return view


@router.post("/api/evaluate")
async def evaluate_conversation(body: EvaluateRequest, request: Request):
    path = request.app.state.database_path
    try:
        context = await run_in_threadpool(load_context, path, body.conversation_id)
        if context is None:
            return JSONResponse(status_code=404, content={"error": f"conversation {body.conversation_id} not loaded"})
        return await run_evaluation(path, context)
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})


async def run_evaluation(path, context):
    """Shared single/batch pipeline; context already pins the conversation and checklist version."""
    start = perf_counter()
    output = await run_in_threadpool(evaluator.evaluate, context["conversation"], context["checklist"])
    elapsed_ms = round((perf_counter() - start) * 1000)
    return await run_in_threadpool(save_evaluation, path, context, output, elapsed_ms)

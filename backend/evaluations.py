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
        connection.execute("INSERT INTO evaluations VALUES (?, ?, ?, ?, ?)",
                           (evaluation["id"], evaluation["conversation_id"], evaluation["checklist_id"],
                            evaluation["checklist_version"], json.dumps(evaluation, ensure_ascii=False)))
        for position, result in enumerate(output["results"]):
            connection.execute("INSERT INTO evaluation_results VALUES (?, ?, ?, ?)",
                               (evaluation["id"], result["criterion_id"], position, json.dumps(result, ensure_ascii=False)))
        results = [json.loads(row["result"]) for row in connection.execute(
            "SELECT result FROM evaluation_results WHERE evaluation_id = ? ORDER BY position", (evaluation["id"],))]
        checklist = json.loads(connection.execute(
            "SELECT checklist FROM checklist_versions WHERE checklist_id = ? AND version = ?",
            (evaluation["checklist_id"], evaluation["checklist_version"]),
        ).fetchone()["checklist"])
        # No appeals exist in this step; new evaluations have identical original/final results.
        view = {**evaluation, "results": results, "appeals": [], "final_results": results,
                "totals": compute_totals(checklist, results), "original_totals": compute_totals(checklist, results),
                "checklist": checklist, "low_confidence": [r["criterion_id"] for r in results
                    if r.get("confidence") is not None and r["confidence"] < 0.67]}
    return view


@router.post("/api/evaluate")
async def evaluate_conversation(body: EvaluateRequest, request: Request):
    path = request.app.state.database_path
    try:
        context = await run_in_threadpool(load_context, path, body.conversation_id)
        if context is None:
            return JSONResponse(status_code=404, content={"error": f"conversation {body.conversation_id} not loaded"})
        start = perf_counter()
        output = await run_in_threadpool(evaluator.evaluate, context["conversation"], context["checklist"])
        elapsed_ms = round((perf_counter() - start) * 1000)
        return await run_in_threadpool(save_evaluation, path, context, output, elapsed_ms)
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})

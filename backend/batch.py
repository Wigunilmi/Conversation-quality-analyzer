"""Batch evaluation with a fixed checklist snapshot and independent transactions."""

import asyncio
import json
import os
from time import perf_counter

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .database import connect
from .evaluations import run_evaluation


router = APIRouter()


class BatchRequest(BaseModel):
    group_id: str | None = None
    only_missing: bool = False
    concurrency: int | None = Field(default=None, ge=1)


def batch_snapshot(path, group_id, only_missing):
    with connect(path) as connection, connection:
        connection.execute("BEGIN")
        # Evaluations and criteria commit together, so a persisted evaluation is completed.
        completed = {(row["conversation_id"], row["checklist_id"], row["checklist_version"])
                     for row in connection.execute("SELECT conversation_id, checklist_id, checklist_version FROM evaluations")} if only_missing else set()
        rows = connection.execute("""SELECT c.id, c.payload, s.id AS checklist_id, s.name, v.version, v.checklist
            FROM conversations c
            LEFT JOIN channel_checklists cc ON cc.channel = c.channel
            LEFT JOIN checklists s ON s.id = cc.checklist_id
            LEFT JOIN checklist_versions v ON v.checklist_id = cc.checklist_id AND v.version = cc.active_version
            ORDER BY c.rowid""").fetchall()
        jobs = []
        for row in rows:
            conversation = json.loads(row["payload"])
            if group_id and conversation.get("group_id") != group_id:
                continue
            if (row["id"], row["checklist_id"], row["version"]) in completed:
                continue
            context = None if row["checklist"] is None else {
                "conversation": conversation, "checklist_id": row["checklist_id"], "checklist_name": row["name"],
                "checklist_version": row["version"], "checklist": json.loads(row["checklist"]),
            }
            jobs.append((row["id"], context))
    return jobs


async def run_batch(path, jobs, concurrency):
    results = [None] * len(jobs)
    pending = iter(enumerate(jobs))

    async def worker():
        for index, (cid, context) in pending:
            try:
                if context is None:
                    raise RuntimeError("No active checklist for conversation channel")
                view = await run_evaluation(path, context)
                results[index] = {"ok": True, "cid": cid, "total": view["totals"]["total"],
                                  "cost_usd": view.get("cost_usd") or 0}
            except Exception as exc:
                results[index] = {"ok": False, "cid": cid, "error": str(exc)}

    # Allocate only a bounded number of workers, not one task per conversation.
    await asyncio.gather(*(worker() for _ in range(min(concurrency, len(jobs)))))
    return results


@router.post("/api/evaluate-batch")
async def evaluate_batch(body: BatchRequest, request: Request):
    try:
        concurrency = body.concurrency if body.concurrency is not None else int(os.environ.get("LLM_CONCURRENCY", "4"))
        if concurrency < 1:
            raise ValueError
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "LLM_CONCURRENCY must be a positive integer"})
    path = request.app.state.database_path
    start = perf_counter()
    jobs = await run_in_threadpool(batch_snapshot, path, body.group_id, body.only_missing)
    results = await run_batch(path, jobs, concurrency)
    return {"count": len(jobs), "ms": round((perf_counter() - start) * 1000),
            "cost_usd": round(sum(result.get("cost_usd", 0) for result in results), 4), "results": results}

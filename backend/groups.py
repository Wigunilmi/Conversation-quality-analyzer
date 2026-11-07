"""Load an organizers' group and upsert conversations without deleting evaluations."""

from datetime import datetime, timezone
import json
import os

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
import httpx
from starlette.concurrency import run_in_threadpool

from .database import connect


router = APIRouter()


class OrganizersError(Exception):
    pass


async def fetch_group(base_url, group_id, transport=None):
    try:
        url = httpx.URL(base_url).copy_set_param("group_id", group_id)
        async with httpx.AsyncClient(transport=transport, timeout=30, follow_redirects=True) as client:
            response = await client.get(url)
        payload = response.json()
    except httpx.HTTPError as exc:
        # Do not expose the upstream URL: it may contain credentials in its query.
        raise OrganizersError("Organizers API: request failed") from exc
    except (ValueError, httpx.InvalidURL) as exc:
        raise OrganizersError("Organizers API: invalid URL or JSON response") from exc

    if not isinstance(payload, dict):
        raise OrganizersError("Organizers API: invalid response")
    if not payload.get("isSuccess"):
        raise OrganizersError(f"Organizers API: {payload.get('error') or response.status_code}")
    if not response.is_success:
        raise OrganizersError(f"Organizers API: HTTP {response.status_code}")
    data = payload.get("data")
    records = data.get("records") if isinstance(data, dict) else None
    if not isinstance(records, list):
        raise OrganizersError("Organizers API: data.records must be an array")
    # Validate the entire response before writing any record.
    for record in records:
        if (not isinstance(record, dict)
                or not isinstance(record.get("conversation_id"), str) or not record["conversation_id"]
                or not isinstance(record.get("channel"), str) or not record["channel"]
                or not isinstance(record.get("transcript"), list)
                or not all(isinstance(line, dict) for line in record["transcript"])):
            raise OrganizersError("Organizers API: invalid conversation record")
    return records


def save_group(path, group_id, records):
    loaded_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    with connect(path) as connection, connection:
        for record in records:
            conversation = {**record, "group_id": group_id, "loaded_at": loaded_at}
            connection.execute(
                """INSERT INTO conversations (id, channel, payload) VALUES (?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, payload = excluded.payload""",
                (record["conversation_id"], record["channel"], json.dumps(conversation, ensure_ascii=False)),
            )
    return len(records)


@router.post("/api/groups/{gid}/load")
async def load_group(gid: str, request: Request):
    base_url = os.environ.get("CQA_API_URL")
    if not base_url:
        return JSONResponse(status_code=500, content={"error": "CQA_API_URL is not set (see .env.example)"})
    try:
        records = await fetch_group(base_url, gid, request.app.state.organizers_transport)
        loaded = await run_in_threadpool(save_group, request.app.state.database_path, gid, records)
    except OrganizersError as exc:
        return JSONResponse(status_code=502, content={"error": str(exc)})
    except Exception:
        return JSONResponse(status_code=500, content={"error": "Could not save conversations"})
    return {"loaded": loaded}

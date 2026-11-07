"""Versioned checklist sets and atomic channel activation."""

from datetime import datetime, timezone
import json
from uuid import uuid4

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .cqa.scoring import validate_checklist
from .database import connect


router = APIRouter()


class ChecklistError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def validated_checklist(body):
    checklist = body.get("checklist")
    if not isinstance(checklist, dict):
        raise ChecklistError(400, "criteria must be a non-empty array")
    try:
        errors = validate_checklist(checklist)
    except (TypeError, KeyError, ValueError, AttributeError):
        raise ChecklistError(400, "invalid checklist") from None
    if errors:
        raise ChecklistError(400, "; ".join(errors))
    return checklist


def validated_channels(channels):
    if not isinstance(channels, list) or any(not isinstance(channel, str) or not channel for channel in channels):
        raise ChecklistError(400, "channels must be an array of non-empty strings")
    return list(dict.fromkeys(channels))


def note_value(body, default=""):
    note = body.get("note") or default
    if not isinstance(note, str):
        raise ChecklistError(400, "note must be a string")
    return note


def add_version(connection, checklist_id, version, checklist, note):
    created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    connection.execute("INSERT INTO checklist_versions VALUES (?, ?, ?)",
                       (checklist_id, version, json.dumps({**checklist, "id": checklist_id}, ensure_ascii=False)))
    connection.execute("INSERT INTO checklist_version_metadata VALUES (?, ?, ?, ?)",
                       (checklist_id, version, created_at, note))
    connection.execute("""INSERT INTO checklist_state VALUES (?, ?)
        ON CONFLICT(checklist_id) DO UPDATE SET active_version = excluded.active_version""", (checklist_id, version))
    connection.execute("UPDATE channel_checklists SET active_version = ? WHERE checklist_id = ?", (version, checklist_id))


def assign_channels(connection, checklist_id, version, channels):
    connection.execute("DELETE FROM channel_checklists WHERE checklist_id = ?", (checklist_id,))
    for channel in channels:
        connection.execute("""INSERT INTO channel_checklists VALUES (?, ?, ?)
            ON CONFLICT(channel) DO UPDATE SET checklist_id = excluded.checklist_id,
            active_version = excluded.active_version""", (channel, checklist_id, version))


def checklist_sets(path):
    with connect(path) as connection, connection:
        connection.execute("BEGIN")
        sets = []
        for row in connection.execute("SELECT * FROM checklists ORDER BY rowid"):
            versions = [{"version": version["version"], "created_at": version["created_at"],
                         "note": version["note"] or "", "checklist": json.loads(version["checklist"])}
                        for version in connection.execute("""SELECT v.*, m.created_at, m.note
                            FROM checklist_versions v LEFT JOIN checklist_version_metadata m
                            ON m.checklist_id = v.checklist_id AND m.version = v.version
                            WHERE v.checklist_id = ? ORDER BY v.version""", (row["id"],))]
            state = connection.execute("SELECT active_version FROM checklist_state WHERE checklist_id = ?", (row["id"],)).fetchone()
            active = state["active_version"] if state else versions[-1]["version"]
            channels = [channel["channel"] for channel in connection.execute(
                "SELECT channel FROM channel_checklists WHERE checklist_id = ? ORDER BY rowid", (row["id"],))]
            sets.append({"id": row["id"], "name": row["name"], "channels": channels, "active": active,
                         "versions": versions, "active_checklist": next(v["checklist"] for v in versions if v["version"] == active)})
    return sets


def create_set(path, body):
    checklist = validated_checklist(body)
    channels = validated_channels(body.get("channels", []))
    note = note_value(body, "Создан")
    checklist_id = body.get("id") or "cl_" + uuid4().hex
    name = body.get("name") or checklist.get("name") or "Новый чек-лист"
    if not isinstance(checklist_id, str) or not isinstance(name, str):
        raise ChecklistError(400, "id and name must be strings")
    with connect(path) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("SELECT 1 FROM checklists WHERE id = ?", (checklist_id,)).fetchone():
            raise ChecklistError(409, "id exists")
        connection.execute("INSERT INTO checklists VALUES (?, ?)", (checklist_id, name))
        add_version(connection, checklist_id, 1, checklist, note)
        assign_channels(connection, checklist_id, 1, channels)
    return {"id": checklist_id}


def create_version(path, checklist_id, body):
    checklist = validated_checklist(body)
    note = note_value(body)
    if checklist.get("name") and not isinstance(checklist["name"], str):
        raise ChecklistError(400, "name must be a string")
    with connect(path) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        if not connection.execute("SELECT 1 FROM checklists WHERE id = ?", (checklist_id,)).fetchone():
            raise ChecklistError(404, "checklist not found")
        version = connection.execute("SELECT COALESCE(MAX(version), 0) + 1 FROM checklist_versions WHERE checklist_id = ?",
                                     (checklist_id,)).fetchone()[0]
        add_version(connection, checklist_id, version, checklist, note)
        if checklist.get("name"):
            connection.execute("UPDATE checklists SET name = ? WHERE id = ?", (checklist["name"], checklist_id))
    return {"version": version}


def activate_set(path, checklist_id, body):
    channels = validated_channels(body["channels"]) if "channels" in body else None
    with connect(path) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        state = connection.execute("SELECT active_version FROM checklist_state WHERE checklist_id = ?", (checklist_id,)).fetchone()
        if state is None:
            raise ChecklistError(404, "checklist not found")
        version = body.get("version", state["active_version"])
        if type(version) is not int or not connection.execute(
            "SELECT 1 FROM checklist_versions WHERE checklist_id = ? AND version = ?", (checklist_id, version),
        ).fetchone():
            raise ChecklistError(404, "version not found")
        connection.execute("UPDATE checklist_state SET active_version = ? WHERE checklist_id = ?", (version, checklist_id))
        connection.execute("UPDATE channel_checklists SET active_version = ? WHERE checklist_id = ?", (version, checklist_id))
        if channels is not None:
            assign_channels(connection, checklist_id, version, channels)
    return {"ok": True}


async def write_response(function, request, *args):
    try:
        return await run_in_threadpool(function, request.app.state.database_path, *args)
    except ChecklistError as exc:
        return JSONResponse(status_code=exc.status, content={"error": str(exc)})
    except Exception:
        return JSONResponse(status_code=500, content={"error": "Could not save checklist"})


@router.get("/api/checklists")
async def get_checklists(request: Request):
    return await run_in_threadpool(checklist_sets, request.app.state.database_path)


@router.post("/api/checklists")
async def post_checklists(body: dict, request: Request):
    return await write_response(create_set, request, body)


@router.post("/api/checklists/{checklist_id}/versions")
async def post_version(checklist_id: str, body: dict, request: Request):
    return await write_response(create_version, request, checklist_id, body)


@router.post("/api/checklists/{checklist_id}/activate")
async def post_activate(checklist_id: str, body: dict, request: Request):
    return await write_response(activate_set, request, checklist_id, body)

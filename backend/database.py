"""SQLite migration and explicit, local-only synthetic seed."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3

from .postgres import PostgresConnection, PostgresDatabase, is_postgres


ROOT = Path(__file__).resolve().parents[1]


def database_path():
    if os.environ.get("DATABASE_URL"):
        url = os.environ["DATABASE_URL"]
        if not is_postgres(url):
            raise RuntimeError("DATABASE_URL must be a PostgreSQL URL")
        return PostgresDatabase(url)
    if os.environ.get("VERCEL"):
        raise RuntimeError("DATABASE_URL is required on Vercel")
    return Path(os.environ.get("CQA_DATABASE_PATH", ROOT / "data" / "cqa.sqlite3"))


@contextmanager
def connect(path):
    if is_postgres(path):
        connection = PostgresConnection(path)
    else:
        connection = sqlite3.connect(path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
    finally:
        connection.close()


def migrate(path):
    if is_postgres(path):
        raise RuntimeError("Run python -m backend.migrate_postgres explicitly")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as connection:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version > 3:
            raise RuntimeError("Database schema is newer than this application")
        if version == 0:
            sql = (Path(__file__).parent / "migrations" / "001_evaluations.sql").read_text(encoding="utf-8")
            connection.executescript(sql)
            version = 1
        if version == 1:
            sql = (Path(__file__).parent / "migrations" / "002_checklist_metadata.sql").read_text(encoding="utf-8")
            connection.executescript(sql)
            version = 2
        if version == 2:
            sql = (Path(__file__).parent / "migrations" / "003_appeals.sql").read_text(encoding="utf-8")
            connection.executescript(sql)


def seed_demo(path):
    """One synthetic chat and one checklist version; never overwrite existing data."""
    checklist = json.loads((ROOT / "checklists" / "chat.json").read_text(encoding="utf-8"))
    conversation = {
        "conversation_id": "synthetic-chat-001",
        "group_id": "SYNTHETIC",
        "channel": "agent chat",
        "language": "RU",
        "transcript": [
            {"timestamp": "2026-01-01T10:00:00Z", "speaker": "client", "text": "Здравствуйте! Где посмотреть тарифы?"},
            {"timestamp": "2026-01-01T10:00:20Z", "speaker": "operator", "text": "Здравствуйте! Меня зовут Анна. Тарифы доступны на официальном сайте в разделе Тарифы."},
            {"timestamp": "2026-01-01T10:00:40Z", "speaker": "client", "text": "Спасибо, нашёл."},
            {"timestamp": "2026-01-01T10:01:00Z", "speaker": "operator", "text": "Спасибо за обращение! До свидания!"},
        ],
    }
    with connect(path) as connection, connection:
        connection.execute("INSERT INTO conversations (id, channel, payload) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                           (conversation["conversation_id"], conversation["channel"], json.dumps(conversation, ensure_ascii=False)))
        connection.execute("INSERT INTO checklists (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING", ("chat", checklist["name"]))
        connection.execute("INSERT INTO checklist_versions VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                           ("chat", 1, json.dumps(checklist, ensure_ascii=False)))
        connection.execute("INSERT INTO channel_checklists (channel, checklist_id, active_version) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", ("agent chat", "chat", 1))
        connection.execute("INSERT INTO checklist_state VALUES (?, ?) ON CONFLICT DO NOTHING", ("chat", 1))
        connection.execute("INSERT INTO checklist_version_metadata VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
                           ("chat", 1, datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "Исходная версия"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-demo", action="store_true")
    args = parser.parse_args()
    path = database_path()
    migrate(path)
    if args.seed_demo:
        seed_demo(path)
    print(f"Database ready: {path}")

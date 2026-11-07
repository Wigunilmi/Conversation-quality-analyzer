"""Explicit PostgreSQL migrations. Never run DDL during a Vercel request/startup."""

import argparse
import os
from pathlib import Path

from .database import connect, seed_demo
from .postgres import PostgresDatabase, is_postgres


SCHEMA_VERSION = 1


def migrate_postgres(target):
    if not is_postgres(target):
        raise RuntimeError("A PostgreSQL DATABASE_URL is required")
    with connect(target) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)")
        versions = {row[0] for row in connection.execute("SELECT version FROM schema_migrations")}
        if versions - {SCHEMA_VERSION}:
            raise RuntimeError("Unsupported PostgreSQL schema version")
        if SCHEMA_VERSION not in versions:
            statement = (Path(__file__).parent / "migrations" / "postgres" / "001_initial.sql").read_text(encoding="utf-8")
            connection.execute(statement)
            connection.execute("INSERT INTO schema_migrations VALUES (?)", (SCHEMA_VERSION,))


def check_postgres_schema(target):
    try:
        with connect(target) as connection:
            versions = {row[0] for row in connection.execute("SELECT version FROM schema_migrations")}
        if versions != {SCHEMA_VERSION}:
            raise RuntimeError
    except Exception:
        raise RuntimeError("PostgreSQL schema unavailable; run python -m backend.migrate_postgres") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-demo", action="store_true")
    args = parser.parse_args()
    url = os.environ.get("DATABASE_MIGRATION_URL") or os.environ.get("DATABASE_URL")
    if not url or not is_postgres(url):
        parser.exit(1, "Set DATABASE_MIGRATION_URL or DATABASE_URL to a PostgreSQL URL\n")
    target = PostgresDatabase(url)
    try:
        migrate_postgres(target)
        if args.seed_demo:
            seed_demo(target)
    except Exception:
        parser.exit(1, "PostgreSQL migration failed; connection details are not printed\n")
    print("PostgreSQL migrations applied" + ("; synthetic seed ready" if args.seed_demo else ""))


if __name__ == "__main__":
    main()

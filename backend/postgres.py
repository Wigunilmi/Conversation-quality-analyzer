"""Small DB-API adapter for the application's parameterized SQL."""

from dataclasses import dataclass, field
import re


@dataclass(frozen=True)
class PostgresDatabase:
    url: str = field(repr=False)
    schema: str | None = None  # Isolated schemas are used only by integration tests.


def is_postgres(target):
    return isinstance(target, PostgresDatabase) or (
        isinstance(target, str) and target.startswith(("postgres://", "postgresql://")))


class Row:
    def __init__(self, names, values):
        self.names = names
        self.values = values

    def __getitem__(self, key):
        return self.values[key] if isinstance(key, int) else self.values[self.names.index(key)]

    def keys(self):
        return self.names

    def __iter__(self):
        return iter(self.values)


def row_factory(cursor):
    names = [column.name for column in cursor.description] if cursor.description else []
    return lambda values: Row(names, values)


def parameter_sql(statement):
    # Preserve question marks inside SQL string literals/quoted identifiers.
    parts = re.split(r"('(?:''|[^'])*'|\"(?:\"\"|[^\"])*\")", statement)
    return "".join(part.replace("%", "%%").replace("?", "%s") if index % 2 == 0
                   else part.replace("%", "%%") for index, part in enumerate(parts))


class PostgresConnection:
    def __init__(self, target):
        import psycopg
        from psycopg import sql

        if not isinstance(target, PostgresDatabase):
            target = PostgresDatabase(target)
        try:
            self.raw = psycopg.connect(target.url, autocommit=True, prepare_threshold=None,
                                       row_factory=row_factory, connect_timeout=10)
        except Exception:
            raise RuntimeError("PostgreSQL connection failed") from None
        self.raw.execute("BEGIN")
        if target.schema:
            self.raw.execute(sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(target.schema)))

    def execute(self, statement, parameters=None):
        command = statement.strip().rstrip(";").upper()
        if command == "BEGIN":
            return self.raw.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        if command == "BEGIN IMMEDIATE":
            # Transaction-scoped lock works with Neon transaction pooling. It serializes
            # version allocation/channel reassignment and appeal conflict checks.
            return self.raw.execute("SELECT pg_advisory_xact_lock(710401)")
        return self.raw.execute(parameter_sql(statement) if parameters is not None else statement, parameters)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.raw.execute("ROLLBACK" if exc_type else "COMMIT")

    def close(self):
        self.raw.close()  # Uncommitted read transactions are rolled back by the server.

"""SQLite storage for the record, in WAL mode.

Each record model has a table (`TABLES`) with a column per field, defined in `schema.sql`. The
store turns records into rows and back; the rules of the record live in the service layer.
"""

import json
import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from importlib.resources import files
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel

from agentorg.models import Ask, AuditEntry, Evidence, Item, Report, Resource, Session, Task

SCHEMA_VERSION = 1

TABLES: dict[type[BaseModel], str] = {
    Session: "sessions",
    Task: "tasks",
    Ask: "asks",
    Item: "items",
    Evidence: "evidence",
    Report: "reports",
    Resource: "resources",
    AuditEntry: "audit",
}

Record = TypeVar("Record", bound=BaseModel)


class Store:
    def __init__(self, path: Path | str) -> None:
        self.connection = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        for pragma in ("journal_mode = WAL", "synchronous = NORMAL", "foreign_keys = ON"):
            self.connection.execute(f"PRAGMA {pragma}")
        self._create_schema()
        self._json_columns = {
            table: {
                column["name"]
                for column in self.execute(f"PRAGMA table_info({table})")
                if column["type"] == "JSON"
            }
            for table in TABLES.values()
        }

    def _create_schema(self) -> None:
        version = self.execute("PRAGMA user_version")[0][0]
        if version == SCHEMA_VERSION:
            return
        if version != 0:
            raise RuntimeError(
                f"the database has schema {version}; this agentorg reads {SCHEMA_VERSION}"
            )
        schema = files(__package__).joinpath("schema.sql").read_text()
        self.connection.executescript(
            f"BEGIN; {schema}; PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"
        )

    def close(self) -> None:
        self.connection.close()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Run the statements inside as one transaction, rolled back if anything raises."""
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.connection.execute("ROLLBACK")
            raise
        self.connection.execute("COMMIT")

    def execute(self, sql: str, parameters: Sequence[Any] = ()) -> list[sqlite3.Row]:
        return self.connection.execute(sql, parameters).fetchall()

    def insert(self, record: BaseModel) -> None:
        table = TABLES[type(record)]
        row = self._row(table, record)
        columns = ", ".join(row)
        placeholders = ", ".join("?" for _ in row)
        self.execute(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", list(row.values()))

    def update(self, record: BaseModel) -> None:
        """Replace the row with the record's id."""
        table = TABLES[type(record)]
        row = self._row(table, record)
        record_id = row.pop("id")
        assignments = ", ".join(f"{column} = ?" for column in row)
        self.execute(f"UPDATE {table} SET {assignments} WHERE id = ?", [*row.values(), record_id])

    def get(self, model: type[Record], record_id: str) -> Record | None:
        records = self.select(model, "id = ?", [record_id])
        return records[0] if records else None

    def select(
        self,
        model: type[Record],
        where: str = "1",
        parameters: Sequence[Any] = (),
        order: str = "rowid",
        limit: int = -1,
    ) -> list[Record]:
        """Records matching an SQL condition, oldest first unless `order` says otherwise."""
        table = TABLES[model]
        rows = self.execute(
            f"SELECT * FROM {table} WHERE {where} ORDER BY {order} LIMIT ?", [*parameters, limit]
        )
        return [self._record(model, table, row) for row in rows]

    def _row(self, table: str, record: BaseModel) -> dict[str, Any]:
        json_columns = self._json_columns[table]
        return {
            column: json.dumps(value) if column in json_columns and value is not None else value
            for column, value in record.model_dump(mode="json").items()
        }

    def _record(self, model: type[Record], table: str, row: sqlite3.Row) -> Record:
        json_columns = self._json_columns[table]
        return model.model_validate(
            {
                column: json.loads(row[column])
                if column in json_columns and row[column] is not None
                else row[column]
                for column in row.keys()
            }
        )

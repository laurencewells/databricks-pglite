import os
from contextlib import asynccontextmanager
from threading import Lock
from typing import Callable, Protocol

import psycopg
from fastapi import FastAPI
from pydantic import BaseModel, Field


class QueryResult(Protocol):
    def fetchone(self) -> tuple[object, ...] | None: ...

    def fetchall(self) -> list[tuple[object, ...]]: ...


class Connection(Protocol):
    def __enter__(self) -> "Connection": ...

    def __exit__(self, *args: object) -> object: ...

    def execute(
        self, query: str, parameters: tuple[object, ...] | None = None
    ) -> QueryResult: ...

    def commit(self) -> None: ...


ConnectionFactory = Callable[[], Connection]


class NoteInput(BaseModel):
    body: str = Field(min_length=1, max_length=10_000)


def connect() -> Connection:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")
    return psycopg.connect(database_url)


def create_app(connection_factory: ConnectionFactory = connect) -> FastAPI:
    database_lock = Lock()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        with database_lock, connection_factory() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS python_example_notes (
                    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    body text NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT now()
                )
                """
            )
            connection.commit()
        yield

    application = FastAPI(title="PGlite Python example", lifespan=lifespan)

    @application.get("/health")
    def health() -> dict[str, str]:
        with database_lock, connection_factory() as connection:
            row = connection.execute("SELECT 1").fetchone()
        if row != (1,):
            raise RuntimeError("database health check failed")
        return {"status": "ok", "database": "ok"}

    @application.post("/notes", status_code=201)
    def create_note(note: NoteInput) -> dict[str, object]:
        with database_lock, connection_factory() as connection:
            row = connection.execute(
                """
                INSERT INTO python_example_notes (body)
                VALUES (%s)
                RETURNING id, body
                """,
                (note.body,),
            ).fetchone()
            connection.commit()
        if row is None:
            raise RuntimeError("note insert returned no row")
        return {"id": row[0], "body": row[1]}

    @application.get("/notes")
    def list_notes() -> list[dict[str, object]]:
        with database_lock, connection_factory() as connection:
            rows = connection.execute(
                "SELECT id, body FROM python_example_notes ORDER BY id"
            ).fetchall()
        return [{"id": row[0], "body": row[1]} for row in rows]

    return application


app = create_app()

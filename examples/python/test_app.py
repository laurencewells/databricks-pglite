from concurrent.futures import ThreadPoolExecutor
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from threading import Lock
from time import sleep

import pytest
from fastapi.testclient import TestClient


APP_PATH = Path(__file__).with_name("app.py")


class QueryResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self):
        self.queries = []
        self.committed = False
        self.notes = []
        self.active = 0
        self.max_active = 0
        self.state_lock = Lock()

    def __enter__(self):
        with self.state_lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        return self

    def __exit__(self, *_args):
        with self.state_lock:
            self.active -= 1
        return None

    def execute(self, query, parameters=None):
        self.queries.append(query)
        if "SELECT 1" in query:
            sleep(0.01)
            return QueryResult([(1,)])
        if "INSERT INTO python_example_notes" in query:
            note = (len(self.notes) + 1, parameters[0])
            self.notes.append(note)
            return QueryResult([note])
        if "SELECT id, body" in query:
            return QueryResult(list(self.notes))
        return QueryResult([])

    def commit(self):
        self.committed = True


def load_example():
    if not APP_PATH.exists():
        pytest.fail("examples/python/app.py does not exist")
    spec = spec_from_file_location("pglite_python_example", APP_PATH)
    assert spec and spec.loader
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_health_checks_the_embedded_database():
    module = load_example()
    connection = Connection()

    with TestClient(module.create_app(lambda: connection)) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}
    assert connection.committed is True
    assert any("CREATE TABLE" in query for query in connection.queries)
    assert any("SELECT 1" in query for query in connection.queries)


def test_notes_round_trip_through_the_embedded_database():
    module = load_example()
    connection = Connection()

    with TestClient(module.create_app(lambda: connection)) as client:
        created = client.post("/notes", json={"body": "Durable from Python"})
        listed = client.get("/notes")

    assert created.status_code == 201
    assert created.json() == {"id": 1, "body": "Durable from Python"}
    assert listed.status_code == 200
    assert listed.json() == [{"id": 1, "body": "Durable from Python"}]
    assert any("INSERT INTO python_example_notes" in query for query in connection.queries)
    assert any("SELECT id, body" in query for query in connection.queries)


def test_empty_notes_are_rejected_before_database_execution():
    module = load_example()
    connection = Connection()

    with TestClient(module.create_app(lambda: connection)) as client:
        response = client.post("/notes", json={"body": ""})

    assert response.status_code == 422
    assert connection.notes == []


def test_concurrent_requests_share_the_single_database_connection_slot():
    module = load_example()
    connection = Connection()

    with TestClient(module.create_app(lambda: connection)) as client:
        with ThreadPoolExecutor(max_workers=10) as executor:
            responses = list(executor.map(lambda _index: client.get("/health"), range(20)))

    assert [response.status_code for response in responses] == [200] * 20
    assert connection.max_active == 1


def test_oversized_notes_are_rejected_before_database_execution():
    module = load_example()
    connection = Connection()

    with TestClient(module.create_app(lambda: connection)) as client:
        response = client.post("/notes", json={"body": "x" * 10_001})

    assert response.status_code == 422
    assert connection.notes == []

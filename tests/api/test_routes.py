from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from agentorg.api import openapi_document
from agentorg.app import create_app
from agentorg.models import Task
from agentorg.operations import OPERATIONS, NotFound, Operations

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

AGENT_TOOLS = {
    "session_start",
    "session_declare_role",
    "session_register",
    "session_archive",
    "task_open",
    "task_close",
    "ask_open",
    "ask_get",
    "ask_wait",
    "ask_record_answer",
    "item_put",
    "item_resolve",
    "report_send",
    "inbox_read",
    "report_ack",
}
USER_OPERATIONS = {
    "session_list",
    "task_list",
    "ask_answer",
    "ask_list",
    "item_list",
    "audit_list",
    "ui_login_link",
}


class Recorder:
    """Builds an `Operations` whose every method records its call and runs `respond`."""

    def __init__(self, respond):
        self.calls = []
        namespace = {name: self._method(name, respond) for name in Operations.__abstractmethods__}
        self.operations = type("RecordingOperations", (Operations,), namespace)()

    def _method(self, name, respond):
        async def method(_self, *args):
            self.calls.append((name, *args))
            return respond(name, *args)

        return method


def open_task(name, request, caller):
    if request.title == "missing":
        raise NotFound("no such parent task")
    return Task(
        id="tsk_1",
        title=request.title,
        project=request.project,
        owner=request.session,
        parent=None,
        state="open",
        opened_at=datetime(2026, 1, 1, tzinfo=UTC),
        closed_at=None,
    )


@pytest.fixture
def recorder():
    return Recorder(open_task)


@pytest.fixture
def client(recorder):
    return TestClient(create_app(recorder.operations, token=TOKEN))


def test_every_operation_has_one_route_and_agents_get_the_design_tools():
    assert {spec.name for spec in OPERATIONS if spec.agent} == AGENT_TOOLS
    assert {spec.name for spec in OPERATIONS if not spec.agent} == USER_OPERATIONS

    document = openapi_document()
    operation_ids = {
        operation["operationId"]: path
        for path, methods in document["paths"].items()
        for operation in methods.values()
    }
    assert set(operation_ids) == AGENT_TOOLS | USER_OPERATIONS
    assert operation_ids["ask_record_answer"] == "/api/ask/record_answer"
    assert document["security"] == [{"bearer": []}]


def test_a_request_reaches_the_service_layer_with_its_model_and_caller(client, recorder):
    response = client.post(
        "/api/task/open",
        json={"session": "ses_1", "title": "Build the store", "project": "agentorg"},
        headers={**AUTH, "Agentorg-Client": "codex", "Agentorg-Client-Session-Id": "c-42"},
    )
    assert response.status_code == 200
    assert response.json()["owner"] == "ses_1"
    name, request, caller = recorder.calls[0]
    assert name == "task_open"
    assert request.project == "agentorg"
    assert (caller.channel, caller.client, caller.client_session_id) == ("api", "codex", "c-42")


def test_an_operation_error_becomes_its_status_and_code(client):
    response = client.post(
        "/api/task/open", json={"title": "missing", "project": "agentorg"}, headers=AUTH
    )
    assert response.status_code == 404
    assert response.json() == {"code": "not_found", "message": "no such parent task"}


def test_an_invalid_request_is_refused_before_the_service_layer(client, recorder):
    response = client.post("/api/task/open", json={"title": "No project"}, headers=AUTH)
    assert response.status_code == 422
    assert recorder.calls == []


@pytest.mark.parametrize("path", ["/api/task/list", "/mcp", "/mcp/anything"])
def test_agent_paths_need_the_bearer_token(client, path):
    assert client.post(path, json={}).status_code == 401
    assert client.post(path, json={}, headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_requests_from_web_pages_are_refused_even_with_the_token(client, recorder):
    response = client.post(
        "/api/task/list", json={}, headers={**AUTH, "Origin": "http://127.0.0.1:8740"}
    )
    assert response.status_code == 403
    assert recorder.calls == []


def test_the_page_and_the_openapi_document_need_no_token(client):
    assert client.get("/").status_code == 404
    response = client.get("/openapi.json")
    assert response.status_code == 200
    assert response.json()["info"]["title"] == "agentorg"

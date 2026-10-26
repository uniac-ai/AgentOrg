from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from agentorg.app import create_app
from agentorg.models import (
    Answer,
    Ask,
    AskListResult,
    Item,
    ItemListResult,
    Option,
    PageSession,
    Session,
    Task,
)
from agentorg.operations import Conflict, Invalid, NotFound, Operations

NOW = datetime(2026, 1, 1, 12, tzinfo=UTC)
LOGIN_TOKEN = "login-token"


def _unused(name):
    async def method(self, *args):
        raise AssertionError(f"the page called {name}")

    return method


_Unused = type("_Unused", (Operations,), {n: _unused(n) for n in Operations.__abstractmethods__})


class FakeOperations(_Unused):
    """The service layer as the page uses it, in memory, recording every answer."""

    def __init__(self):
        self.tasks: dict[str, Task] = {}
        self.sessions: dict[str, Session] = {}
        self.asks: dict[str, Ask] = {}
        self.items: dict[str, Item] = {}
        self.answers = []
        self.login_tokens = {LOGIN_TOKEN}
        self.page_sessions: dict[str, PageSession] = {}
        self.add_session("ses_1", "Storage migration")

    def add_task(self, id, project, title=None):
        self.tasks[id] = Task(
            id=id,
            title=title or f"Task {id}",
            project=project,
            owner=None,
            parent=None,
            state="open",
            opened_at=NOW,
            closed_at=None,
        )

    def add_session(self, id, title):
        self.sessions[id] = Session(
            id=id,
            client="test",
            client_session_id=None,
            title=title,
            parent=None,
            task=None,
            machine="here",
            started_at=NOW,
            archived_at=None,
        )

    def add_ask(self, id, task, minutes_ago, *, session="ses_1", labels=("Yes", "No"), **fields):
        self.asks[id] = Ask(
            id=id,
            task=task,
            session=session,
            title=fields.pop("title", f"Question {id}?"),
            context=fields.pop("context", f"Context of {id}."),
            options=[Option(label=label) for label in labels],
            recommendation=fields.pop("recommendation", labels[0]),
            state=fields.pop("state", "open"),
            answer=fields.pop("answer", None),
            opened_at=NOW - timedelta(minutes=minutes_ago),
        )

    def add_item(self, id, task, minutes_ago, **fields):
        self.items[id] = Item(
            id=id,
            task=task,
            session=fields.pop("session", "ses_1"),
            title=fields.pop("title", f"Item {id}"),
            state=fields.pop("state", "running"),
            summary=fields.pop("summary", ""),
            links=fields.pop("links", []),
            evidence=[],
            blockers=fields.pop("blockers", []),
            updated_at=NOW - timedelta(minutes=minutes_ago),
            resolved_at=None,
        )

    async def redeem_login_token(self, token):
        if token not in self.login_tokens:
            raise Invalid("unknown, used or expired token")
        self.login_tokens.remove(token)
        page_session = PageSession(
            id=f"page_{len(self.page_sessions) + 1}",
            csrf_token=f"csrf_{len(self.page_sessions) + 1}",
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        self.page_sessions[page_session.id] = page_session
        return page_session

    async def get_page_session(self, session_id):
        return self.page_sessions.get(session_id)

    def _related(self, records):
        tasks = {r.task for r in records}
        sessions = {r.session for r in records}
        return (
            [t for t in self.tasks.values() if t.id in tasks],
            [s for s in self.sessions.values() if s.id in sessions],
        )

    async def ask_list(self, request, caller):
        asks = [a for a in self.asks.values() if a.state == request.state]
        tasks, sessions = self._related(asks)
        return AskListResult(asks=asks, tasks=tasks, sessions=sessions)

    async def item_list(self, request, caller):
        items = list(self.items.values())
        tasks, sessions = self._related(items)
        return ItemListResult(items=items, tasks=tasks, sessions=sessions)

    async def ask_get(self, request, caller):
        if request.ask not in self.asks:
            raise NotFound("no such ask")
        return self.asks[request.ask]

    async def ask_answer(self, request, caller):
        self.answers.append((request, caller))
        ask = self.asks.get(request.ask)
        if ask is None:
            raise NotFound("no such ask")
        if ask.state != "open":
            raise Conflict("the ask is not open")
        if request.choice is not None and request.choice not in [o.label for o in ask.options]:
            raise Invalid(f"{request.choice!r} is not one of the ask's options")
        answer = Answer(choice=request.choice, words=request.words, channel="page", answered_at=NOW)
        self.asks[ask.id] = ask.model_copy(update={"state": "answered", "answer": answer})
        return self.asks[ask.id]


@pytest.fixture
def operations():
    return FakeOperations()


@pytest.fixture
def client(operations):
    return TestClient(create_app(operations, token="agents-token"))


@pytest.fixture
def login_link():
    """The path of the one login link the fake service has minted."""
    return f"/ui/login?token={LOGIN_TOKEN}"


@pytest.fixture
def signed_in(client, login_link):
    """A client signed in through the login link; its CSRF token is `csrf_1`."""
    response = client.get(login_link, follow_redirects=False)
    assert response.status_code == 303
    return client

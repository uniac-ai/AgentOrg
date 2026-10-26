import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from agentorg.models import (
    AskAnswer,
    AskGet,
    AskList,
    AskOpen,
    AskRecordAnswer,
    AskWait,
    AskWithdraw,
    AuditList,
    InboxRead,
    ItemList,
    ItemPut,
    ItemResolve,
    LoginLinkCreate,
    ReportAck,
    ReportSend,
    SessionArchive,
    SessionContext,
    SessionStart,
    TaskClose,
    TaskOpen,
)
from agentorg.operations import Caller, Conflict, Forbidden, Invalid, NotFound
from agentorg.operations.service import Service
from agentorg.store import Store

API = Caller(channel="api")
MCP = Caller(channel="mcp", client="claude-code", client_session_id="cc-1")
PAGE = Caller(channel="page")


class Clock:
    def __init__(self):
        self.now = datetime(2026, 1, 1, tzinfo=UTC)

    def __call__(self):
        return self.now


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def service(tmp_path, clock):
    store = Store(tmp_path / "agentorg.db")
    yield Service(store, clock=clock, machine="laptop")
    store.close()


async def start(service, title, caller=API, **fields):
    result = await service.session_start(
        SessionStart(title=title, **({"client": "script"} | fields)), caller
    )
    return result.session


async def open_ask(service, session, **fields):
    request = {
        "session": session,
        "title": "Which database?",
        "context": "The service needs one store.",
        "options": [{"label": "SQLite"}, {"label": "Postgres"}],
        "recommendation": "SQLite",
    }
    return await service.ask_open(AskOpen.model_validate(request | fields), API)


@pytest.mark.anyio
async def test_starting_again_with_the_same_client_session_resumes_it(service):
    first = await service.session_start(SessionStart(title="Build"), MCP)
    again = await service.session_start(SessionStart(title="Build, resumed"), MCP)
    other = await service.session_start(
        SessionStart(title="Build"), Caller(channel="mcp", client="codex", client_session_id="cc-1")
    )
    assert first.session.client == "claude-code"
    assert first.session.machine == "laptop"
    assert again.session == first.session
    assert other.session.id != first.session.id


@pytest.mark.anyio
async def test_a_start_needs_a_client_and_existing_parent_and_task(service):
    with pytest.raises(Invalid):
        await service.session_start(SessionStart(title="Build"), API)
    with pytest.raises(Invalid):
        await service.session_start(
            SessionStart(title="Build"), Caller(channel="api", client="Not A Kind")
        )
    with pytest.raises(NotFound):
        await start(service, "Build", parent="ses_404")
    with pytest.raises(NotFound):
        await start(service, "Build", task="tsk_404")


@pytest.mark.anyio
async def test_start_returns_the_parent_task_own_asks_and_unacknowledged_reports(service):
    manager = await start(service, "Manage", client_session_id="m")
    task = await service.task_open(TaskOpen(session=manager.id, title="Store", project="core"), API)
    child = await start(service, "Build", parent=manager.id, task=task.id, client_session_id="c")
    ask = await open_ask(service, child.id)
    await service.ask_answer(AskAnswer(ask=ask.id, choice="SQLite"), PAGE)
    report = await service.report_send(ReportSend(session=child.id, outcome="Done."), API)

    manager_facts = await service.session_start(
        SessionStart(client="script", title="x", client_session_id="m"), API
    )
    assert manager_facts.session == manager
    assert [r.id for r in manager_facts.inbox] == [report.id]

    child_facts = await service.session_start(
        SessionStart(client="script", title="x", client_session_id="c"), API
    )
    assert child_facts.parent == manager
    assert child_facts.task == task
    assert [a.answer.choice for a in child_facts.asks] == ["SQLite"]


@pytest.mark.anyio
async def test_an_ask_belongs_to_its_sessions_task_and_is_answered_once(service):
    task = await service.task_open(TaskOpen(title="Store", project="core"), API)
    session = await start(service, "Build", task=task.id)
    ask = await open_ask(service, session.id)
    assert ask.task == task.id
    listed = await service.ask_list(AskList(), API)
    assert (listed.asks, listed.tasks, listed.sessions) == ([ask], [task], [session])

    with pytest.raises(Invalid):
        await service.ask_answer(AskAnswer(ask=ask.id, choice="MySQL"), PAGE)
    answered = await service.ask_answer(AskAnswer(ask=ask.id, choice="SQLite", words="Go."), PAGE)
    assert (answered.state, answered.answer.channel, answered.answer.words) == (
        "answered",
        "page",
        "Go.",
    )
    with pytest.raises(Conflict):
        await service.ask_answer(AskAnswer(ask=ask.id, choice="Postgres"), API)
    assert (await service.ask_list(AskList(), API)).asks == []
    assert (await service.ask_list(AskList(state=None), API)).asks == [answered]
    assert (await service.ask_get(AskGet(ask=ask.id), API)) == answered


@pytest.mark.anyio
async def test_only_the_asking_session_records_an_answer_from_its_conversation(service):
    asker = await start(service, "Build")
    other = await start(service, "Other")
    ask = await open_ask(service, asker.id)
    with pytest.raises(Forbidden):
        await service.ask_record_answer(
            AskRecordAnswer(session=other.id, ask=ask.id, words="Use SQLite"), MCP
        )
    recorded = await service.ask_record_answer(
        AskRecordAnswer(session=asker.id, ask=ask.id, words="Use SQLite", choice="SQLite"), MCP
    )
    assert recorded.answer.channel == "session"
    assert recorded.answer.words == "Use SQLite"


@pytest.mark.anyio
async def test_a_wait_returns_when_the_ask_is_answered(service):
    session = await start(service, "Build")
    ask = await open_ask(service, session.id)
    waiter = asyncio.create_task(service.ask_wait(AskWait(ask=ask.id), MCP))
    await asyncio.sleep(0.05)
    assert not waiter.done()
    await service.ask_answer(AskAnswer(ask=ask.id, choice="Postgres"), API)
    answered = await asyncio.wait_for(waiter, timeout=5)
    assert answered.answer.choice == "Postgres"
    assert (await service.ask_wait(AskWait(ask=ask.id), MCP)) == answered


@pytest.mark.anyio
async def test_a_wait_with_a_timeout_returns_the_open_ask(service):
    session = await start(service, "Build")
    ask = await open_ask(service, session.id)
    still_open = await service.ask_wait(AskWait(ask=ask.id, timeout_seconds=0.01), API)
    assert still_open.state == "open"
    with pytest.raises(NotFound):
        await service.ask_wait(AskWait(ask="ask_404", timeout_seconds=0.01), API)


@pytest.mark.anyio
async def test_items_are_replaced_and_resolved(service):
    task = await service.task_open(TaskOpen(title="Store", project="core"), API)
    session = await start(service, "Build", task=task.id)
    item = await service.item_put(
        ItemPut(session=session.id, title="Store", state="running", blockers=["CI"]), API
    )
    assert item.task == task.id
    replaced = await service.item_put(
        ItemPut(item=item.id, title="Store", state="review", summary="PR open."), API
    )
    assert (replaced.state, replaced.session, replaced.blockers) == ("review", session.id, [])
    listed = await service.item_list(ItemList(task=task.id), API)
    assert (listed.items, listed.tasks, listed.sessions) == ([replaced], [task], [session])

    resolved = await service.item_resolve(ItemResolve(item=item.id), API)
    assert resolved.resolved_at is not None
    assert (await service.item_resolve(ItemResolve(item=item.id), API)) == resolved
    assert (await service.item_list(ItemList(), API)).items == []
    assert (await service.item_list(ItemList(include_resolved=True), API)).items == [resolved]
    with pytest.raises(Conflict):
        await service.item_put(ItemPut(item=item.id, title="Store", state="running"), API)


@pytest.mark.anyio
async def test_a_report_goes_to_the_parent_until_the_parent_acknowledges_it(service):
    manager = await start(service, "Manage")
    child = await start(service, "Build", parent=manager.id)
    ask = await open_ask(service, child.id)
    report = await service.report_send(ReportSend(session=child.id, outcome="Store done."), MCP)
    assert (report.recipient, report.open_asks) == (manager.id, [ask.id])
    assert (await service.inbox_read(InboxRead(session=manager.id), API)).reports == [report]

    with pytest.raises(Forbidden):
        await service.report_ack(ReportAck(session=child.id, report=report.id), API)
    acknowledged = await service.report_ack(ReportAck(session=manager.id, report=report.id), API)
    assert acknowledged.acknowledged_at is not None
    assert (await service.report_ack(ReportAck(session=manager.id, report=report.id), API)) == (
        acknowledged
    )
    assert (await service.inbox_read(InboxRead(session=manager.id), API)).reports == []

    top = await service.report_send(ReportSend(session=manager.id, outcome="All done."), API)
    assert top.recipient is None


@pytest.mark.anyio
async def test_only_the_asking_session_withdraws_an_ask_and_a_wait_returns(service):
    asker = await start(service, "Build")
    other = await start(service, "Other")
    ask = await open_ask(service, asker.id)
    waiter = asyncio.create_task(service.ask_wait(AskWait(ask=ask.id), MCP))
    await asyncio.sleep(0.05)
    with pytest.raises(Forbidden):
        await service.ask_withdraw(AskWithdraw(session=other.id, ask=ask.id), MCP)
    withdrawn = await service.ask_withdraw(AskWithdraw(session=asker.id, ask=ask.id), MCP)
    assert (withdrawn.state, withdrawn.answer) == ("withdrawn", None)
    assert await asyncio.wait_for(waiter, timeout=5) == withdrawn
    with pytest.raises(Conflict):
        await service.ask_withdraw(AskWithdraw(session=asker.id, ask=ask.id), MCP)
    with pytest.raises(Conflict):
        await service.ask_answer(AskAnswer(ask=ask.id, choice="SQLite"), PAGE)
    assert (await service.ask_list(AskList(), API)).asks == []
    resumed = await service.session_start(
        SessionStart(title="Build"), Caller(channel="mcp", client="script")
    )
    assert resumed.asks == []


@pytest.mark.anyio
async def test_archiving_withdraws_open_asks_and_returns_the_cleanup_list(service):
    session = await start(service, "Build")
    item = await service.item_put(ItemPut(session=session.id, title="Store", state="running"), API)
    ask = await open_ask(service, session.id)
    answered = await open_ask(service, session.id)
    await service.ask_answer(AskAnswer(ask=answered.id, choice="SQLite"), PAGE)

    result = await service.session_archive(SessionArchive(session=session.id), API)
    assert result.session.archived_at is not None
    assert (result.items, result.evidence) == ([item], [])
    assert [(a.id, a.state) for a in result.withdrawn_asks] == [(ask.id, "withdrawn")]
    again = await service.session_archive(SessionArchive(session=session.id), API)
    assert (again.session, again.items, again.withdrawn_asks) == (result.session, [item], [])


@pytest.mark.anyio
async def test_an_archived_session_cannot_write(service):
    manager = await start(service, "Manage")
    child = await start(service, "Build", parent=manager.id)
    ask = await open_ask(service, child.id)
    await service.session_archive(SessionArchive(session=child.id), API)
    for write in (
        lambda: open_ask(service, child.id),
        lambda: service.item_put(ItemPut(session=child.id, title="Store", state="running"), API),
        lambda: service.report_send(ReportSend(session=child.id, outcome="Late."), MCP),
        lambda: service.ask_withdraw(AskWithdraw(session=child.id, ask=ask.id), MCP),
    ):
        with pytest.raises(Conflict, match="is archived"):
            await write()
    assert (await service.session_archive(SessionArchive(session=child.id), API)).session.id
    entries = (await service.audit_list(AuditList(session=child.id), API)).entries
    assert [e.outcome for e in entries[:4]] == ["ok", "conflict", "conflict", "conflict"]


@pytest.mark.anyio
async def test_context_reads_a_started_client_session_without_starting_one(service):
    unknown = await service.session_context(SessionContext(), MCP)
    assert unknown.facts is None
    assert (await service.session_context(SessionContext(client="claude-code"), API)).facts is None

    started = await service.session_start(SessionStart(title="Build"), MCP)
    ask = await open_ask(service, started.session.id)
    known = await service.session_context(SessionContext(), MCP)
    assert known.facts.session == started.session
    assert [a.id for a in known.facts.asks] == [ask.id]
    by_request = await service.session_context(
        SessionContext(client="claude-code", client_session_id="cc-1"), API
    )
    assert by_request == known
    assert (await service.audit_list(AuditList(), API)).entries[0].operation == "ask_open"


@pytest.mark.anyio
async def test_every_write_is_audited_with_its_outcome_and_reads_are_not(service):
    session = await start(service, "Build", caller=MCP, client=None)
    task = await service.task_open(TaskOpen(session=session.id, title="t", project="p"), MCP)
    await service.task_close(TaskClose(task=task.id), API)
    await service.ask_list(AskList(), API)
    with pytest.raises(NotFound):
        await service.ask_answer(AskAnswer(ask="ask_404", choice="x"), PAGE)

    entries = (await service.audit_list(AuditList(), API)).entries
    assert [(e.operation, e.target, e.channel, e.outcome) for e in entries] == [
        ("ask_answer", "ask_404", "page", "not_found"),
        ("task_close", task.id, "api", "ok"),
        ("task_open", task.id, "mcp", "ok"),
        ("session_start", session.id, "mcp", "ok"),
    ]
    assert entries[2].session == session.id
    assert entries[3].client == "claude-code"
    own = (await service.audit_list(AuditList(session=session.id, limit=1), API)).entries
    assert [e.operation for e in own] == ["task_open"]


@pytest.mark.anyio
async def test_a_login_link_works_once_and_before_it_expires(service, clock):
    link = await service.ui_login_link(LoginLinkCreate(), API)
    token = link.path.removeprefix("/ui/login?token=")
    page_session = await service.redeem_login_token(token)
    assert await service.get_page_session(page_session.id) == page_session
    assert await service.get_page_session("unknown") is None
    with pytest.raises(Invalid):
        await service.redeem_login_token(token)

    late = await service.ui_login_link(LoginLinkCreate(), API)
    clock.now += timedelta(minutes=6)
    with pytest.raises(Invalid):
        await service.redeem_login_token(late.path.removeprefix("/ui/login?token="))

    clock.now += timedelta(days=7)
    assert await service.get_page_session(page_session.id) is None

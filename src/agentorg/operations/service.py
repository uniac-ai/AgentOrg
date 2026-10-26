"""The service layer over the SQLite store: the rules of the record, the audit log, and waits.

Operations that move a record forward (closing, resolving, acknowledging, archiving) succeed again
on a record already there. Answering does not: a second answer would be a different decision.
A write whose acting session is archived is refused, so a stale session cannot add to the record
after its manager archived it.
"""

import asyncio
import functools
import hashlib
import secrets
import socket
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from agentorg.models import (
    Answer,
    AnswerChannel,
    Ask,
    AskAnswer,
    AskGet,
    AskList,
    AskListResult,
    AskOpen,
    AskRecordAnswer,
    AskWait,
    AskWithdraw,
    AuditEntry,
    AuditList,
    AuditListResult,
    Evidence,
    Inbox,
    InboxRead,
    Item,
    ItemList,
    ItemListResult,
    ItemPut,
    ItemResolve,
    LoginLink,
    LoginLinkCreate,
    PageSession,
    Report,
    ReportAck,
    ReportSend,
    Session,
    SessionArchive,
    SessionArchiveResult,
    SessionContext,
    SessionContextResult,
    SessionFacts,
    SessionStart,
    Task,
    TaskClose,
    TaskOpen,
)
from agentorg.operations.errors import (
    Conflict,
    Forbidden,
    Invalid,
    NotFound,
    OperationError,
    invalid,
)
from agentorg.operations.interface import OPERATIONS, Caller, Operations, OperationSpec
from agentorg.store import Store

LOGIN_LINK_LIFETIME = timedelta(minutes=5)
PAGE_SESSION_LIFETIME = timedelta(days=7)

Record = TypeVar("Record", bound=BaseModel)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


def _digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


class Service(Operations):
    def __init__(
        self,
        store: Store,
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        machine: str | None = None,
    ) -> None:
        self.store = store
        self.clock = clock
        self.machine = machine or socket.gethostname()
        self._settled: dict[str, asyncio.Event] = {}

    def _get(self, model: type[Record], record_id: str) -> Record:
        record = self.store.get(model, record_id)
        if record is None:
            raise NotFound(f"there is no {model.__name__.lower()} {record_id}")
        return record

    # Sessions

    async def session_start(self, request: SessionStart, caller: Caller) -> SessionFacts:
        try:
            request = SessionStart.model_validate(
                request.model_dump()
                | {
                    "client": request.client or caller.client,
                    "client_session_id": request.client_session_id or caller.client_session_id,
                }
            )
        except ValidationError as error:
            raise invalid(error.errors()) from None
        if request.client is None:
            raise Invalid("name the client kind, such as claude-code or codex")
        session = self._client_session(request.client, request.client_session_id)
        if session is None:
            if request.parent is not None:
                self._get(Session, request.parent)
            if request.task is not None:
                self._get(Task, request.task)
            session = Session(
                id=_new_id("ses"),
                client=request.client,
                client_session_id=request.client_session_id,
                title=request.title,
                parent=request.parent,
                task=request.task,
                machine=request.machine or self.machine,
                started_at=self.clock(),
                archived_at=None,
            )
            self.store.insert(session)
        return self._facts(session)

    async def session_context(
        self, request: SessionContext, caller: Caller
    ) -> SessionContextResult:
        session = self._client_session(
            request.client or caller.client,
            request.client_session_id or caller.client_session_id,
        )
        return SessionContextResult(facts=self._facts(session) if session else None)

    def _client_session(self, client: str | None, client_session_id: str | None) -> Session | None:
        if client is None or client_session_id is None:
            return None
        found = self.store.select(
            Session, "client = ? AND client_session_id = ?", [client, client_session_id]
        )
        return found[0] if found else None

    def _facts(self, session: Session) -> SessionFacts:
        return SessionFacts(
            session=session,
            parent=self.store.get(Session, session.parent) if session.parent else None,
            task=self.store.get(Task, session.task) if session.task else None,
            asks=self.store.select(Ask, "session = ? AND state != 'withdrawn'", [session.id]),
            inbox=self._inbox(session.id),
        )

    async def session_archive(
        self, request: SessionArchive, caller: Caller
    ) -> SessionArchiveResult:
        session = self._get(Session, request.session)
        withdrawn = []
        if session.archived_at is None:
            session = session.model_copy(update={"archived_at": self.clock()})
            with self.store.transaction():
                self.store.update(session)
                for ask in self.store.select(Ask, "session = ? AND state = 'open'", [session.id]):
                    withdrawn.append(self._settle(ask.model_copy(update={"state": "withdrawn"})))
        return SessionArchiveResult(
            session=session,
            items=self.store.select(Item, "session = ? AND resolved_at IS NULL", [session.id]),
            evidence=self.store.select(
                Evidence, "item IN (SELECT id FROM items WHERE session = ?)", [session.id]
            ),
            withdrawn_asks=withdrawn,
        )

    # Tasks

    async def task_open(self, request: TaskOpen, caller: Caller) -> Task:
        if request.session is not None:
            self._get(Session, request.session)
        if request.parent is not None:
            self._get(Task, request.parent)
        task = Task(
            id=_new_id("tsk"),
            title=request.title,
            project=request.project,
            owner=request.session,
            parent=request.parent,
            state="open",
            opened_at=self.clock(),
            closed_at=None,
        )
        self.store.insert(task)
        return task

    async def task_close(self, request: TaskClose, caller: Caller) -> Task:
        task = self._get(Task, request.task)
        if task.state == "open":
            task = task.model_copy(update={"state": "closed", "closed_at": self.clock()})
            self.store.update(task)
        return task

    # Asks

    async def ask_open(self, request: AskOpen, caller: Caller) -> Ask:
        session = self._get(Session, request.session)
        task = request.task or session.task
        if task is not None:
            self._get(Task, task)
        ask = Ask(
            id=_new_id("ask"),
            task=task,
            session=session.id,
            title=request.title,
            context=request.context,
            options=request.options,
            recommendation=request.recommendation,
            state="open",
            answer=None,
            opened_at=self.clock(),
        )
        self.store.insert(ask)
        return ask

    async def ask_get(self, request: AskGet, caller: Caller) -> Ask:
        return self._get(Ask, request.ask)

    async def ask_wait(self, request: AskWait, caller: Caller) -> Ask:
        ask = self._get(Ask, request.ask)
        if ask.state != "open":
            return ask
        settled = self._settled.setdefault(ask.id, asyncio.Event())
        try:
            await asyncio.wait_for(settled.wait(), request.timeout_seconds)
        except TimeoutError:
            pass
        return self._get(Ask, request.ask)

    async def ask_record_answer(self, request: AskRecordAnswer, caller: Caller) -> Ask:
        ask = self._get(Ask, request.ask)
        if ask.session != request.session:
            raise Forbidden(f"only {ask.session}, the session that asked, records its answer")
        return self._answer(ask, request.choice, request.words, "session")

    async def ask_withdraw(self, request: AskWithdraw, caller: Caller) -> Ask:
        ask = self._get(Ask, request.ask)
        if ask.session != request.session:
            raise Forbidden(f"only {ask.session}, the session that asked, withdraws it")
        if ask.state != "open":
            raise Conflict(f"ask {ask.id} is already {ask.state}")
        return self._settle(ask.model_copy(update={"state": "withdrawn"}))

    async def ask_answer(self, request: AskAnswer, caller: Caller) -> Ask:
        return self._answer(self._get(Ask, request.ask), request.choice, request.words, "page")

    def _answer(
        self, ask: Ask, choice: str | None, words: str | None, channel: AnswerChannel
    ) -> Ask:
        if ask.state != "open":
            raise Conflict(f"ask {ask.id} is already {ask.state}")
        labels = [option.label for option in ask.options]
        if choice is not None and choice not in labels:
            raise Invalid(f"the choice must be one of the options: {', '.join(labels)}")
        answer = Answer(choice=choice, words=words, channel=channel, answered_at=self.clock())
        return self._settle(ask.model_copy(update={"state": "answered", "answer": answer}))

    def _settle(self, ask: Ask) -> Ask:
        """Store an ask that has left the open state, and wake whoever waits on it."""
        self.store.update(ask)
        waiting = self._settled.pop(ask.id, None)
        if waiting is not None:
            waiting.set()
        return ask

    async def ask_list(self, request: AskList, caller: Caller) -> AskListResult:
        if request.state is None:
            asks = self.store.select(Ask)
        else:
            asks = self.store.select(Ask, "state = ?", [request.state])
        return AskListResult(
            asks=asks,
            tasks=self._referenced(Task, [ask.task for ask in asks]),
            sessions=self._referenced(Session, [ask.session for ask in asks]),
        )

    def _referenced(self, model: type[Record], ids: list[str | None]) -> list[Record]:
        """The records with these ids, once each, oldest first."""
        wanted = sorted({record_id for record_id in ids if record_id is not None})
        if not wanted:
            return []
        placeholders = ", ".join("?" for _ in wanted)
        return self.store.select(model, f"id IN ({placeholders})", wanted)

    # Items

    async def item_put(self, request: ItemPut, caller: Caller) -> Item:
        session = self._get(Session, request.session) if request.session is not None else None
        if request.task is not None:
            self._get(Task, request.task)
        fields = {
            "title": request.title,
            "state": request.state,
            "summary": request.summary,
            "links": request.links,
            "blockers": request.blockers,
            "updated_at": self.clock(),
        }
        if request.item is None:
            item = Item(
                id=_new_id("itm"),
                task=request.task or (session.task if session else None),
                session=request.session,
                evidence=[],
                resolved_at=None,
                **fields,
            )
            self.store.insert(item)
            return item
        item = self._get(Item, request.item)
        if item.resolved_at is not None:
            raise Conflict(f"item {item.id} is resolved; put a new item instead")
        named = {"session": request.session, "task": request.task}
        item = item.model_copy(
            update=fields | {key: value for key, value in named.items() if value is not None}
        )
        self.store.update(item)
        return item

    async def item_resolve(self, request: ItemResolve, caller: Caller) -> Item:
        item = self._get(Item, request.item)
        if item.resolved_at is None:
            item = item.model_copy(update={"resolved_at": self.clock()})
            self.store.update(item)
        return item

    async def item_list(self, request: ItemList, caller: Caller) -> ItemListResult:
        conditions, parameters = [], []
        if request.task is not None:
            conditions.append("task = ?")
            parameters.append(request.task)
        if not request.include_resolved:
            conditions.append("resolved_at IS NULL")
        items = self.store.select(Item, " AND ".join(conditions) or "1", parameters)
        return ItemListResult(
            items=items,
            tasks=self._referenced(Task, [item.task for item in items]),
            sessions=self._referenced(Session, [item.session for item in items]),
        )

    # Reports

    async def report_send(self, request: ReportSend, caller: Caller) -> Report:
        session = self._get(Session, request.session)
        for evidence in request.evidence:
            self._get(Evidence, evidence)
        open_asks = self.store.select(Ask, "session = ? AND state = 'open'", [session.id])
        report = Report(
            id=_new_id("rep"),
            sender=session.id,
            recipient=session.parent,
            outcome=request.outcome,
            open_asks=[ask.id for ask in open_asks],
            evidence=request.evidence,
            sent_at=self.clock(),
            acknowledged_at=None,
        )
        self.store.insert(report)
        return report

    async def inbox_read(self, request: InboxRead, caller: Caller) -> Inbox:
        self._get(Session, request.session)
        return Inbox(reports=self._inbox(request.session))

    def _inbox(self, session: str) -> list[Report]:
        return self.store.select(Report, "recipient = ? AND acknowledged_at IS NULL", [session])

    async def report_ack(self, request: ReportAck, caller: Caller) -> Report:
        report = self._get(Report, request.report)
        if report.recipient != request.session:
            raise Forbidden(f"only the report's recipient, {report.recipient}, acknowledges it")
        if report.acknowledged_at is None:
            report = report.model_copy(update={"acknowledged_at": self.clock()})
            self.store.update(report)
        return report

    # Audit

    async def audit_list(self, request: AuditList, caller: Caller) -> AuditListResult:
        where, parameters = ("session = ?", [request.session]) if request.session else ("1", [])
        entries = self.store.select(
            AuditEntry, where, parameters, order="id DESC", limit=request.limit
        )
        return AuditListResult(entries=entries)

    def _refuse_archived(self, session_id: str | None) -> None:
        session = self.store.get(Session, session_id) if session_id else None
        if session is not None and session.archived_at is not None:
            raise Conflict(f"session {session.id} is archived")

    def _audit(
        self,
        spec: OperationSpec,
        request: BaseModel,
        caller: Caller,
        target: str | None,
        outcome: str,
    ) -> None:
        session = getattr(request, "session", None)
        if session is None and spec.subject == "session":
            session = target
        client = caller.client
        if client is None and session is not None:
            acting = self.store.get(Session, session)
            client = acting.client if acting else None
        self.store.execute(
            "INSERT INTO audit (at, session, client, operation, target, channel, outcome)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            [self.clock().isoformat(), session, client, spec.name, target, caller.channel, outcome],
        )

    # Decisions page sign-in

    async def ui_login_link(self, request: LoginLinkCreate, caller: Caller) -> LoginLink:
        token = secrets.token_urlsafe(32)
        expires_at = self.clock() + LOGIN_LINK_LIFETIME
        self.store.execute(
            "INSERT INTO login_tokens (token_hash, expires_at) VALUES (?, ?)",
            [_digest(token), expires_at.isoformat()],
        )
        return LoginLink(path=f"/ui/login?token={token}", expires_at=expires_at)

    async def redeem_login_token(self, token: str) -> PageSession:
        rows = self.store.execute(
            "SELECT expires_at FROM login_tokens WHERE token_hash = ? AND used_at IS NULL",
            [_digest(token)],
        )
        now = self.clock()
        if not rows or datetime.fromisoformat(rows[0]["expires_at"]) <= now:
            raise Invalid("this sign-in link is unknown, used or expired; run agentorg ui again")
        page_session = PageSession(
            id=secrets.token_urlsafe(32),
            csrf_token=secrets.token_urlsafe(32),
            expires_at=now + PAGE_SESSION_LIFETIME,
        )
        with self.store.transaction():
            self.store.execute(
                "UPDATE login_tokens SET used_at = ? WHERE token_hash = ?",
                [now.isoformat(), _digest(token)],
            )
            self.store.execute(
                "INSERT INTO page_sessions (id_hash, csrf_token, expires_at) VALUES (?, ?, ?)",
                [
                    _digest(page_session.id),
                    page_session.csrf_token,
                    page_session.expires_at.isoformat(),
                ],
            )
        return page_session

    async def get_page_session(self, session_id: str) -> PageSession | None:
        rows = self.store.execute(
            "SELECT csrf_token, expires_at FROM page_sessions WHERE id_hash = ?",
            [_digest(session_id)],
        )
        if not rows:
            return None
        expires_at = datetime.fromisoformat(rows[0]["expires_at"])
        if expires_at <= self.clock():
            return None
        return PageSession(id=session_id, csrf_token=rows[0]["csrf_token"], expires_at=expires_at)


def _target(result: BaseModel) -> str | None:
    if isinstance(result, SessionFacts | SessionArchiveResult):
        return result.session.id
    return getattr(result, "id", None)


def _write(spec: OperationSpec, method: Callable) -> Callable:
    """Wrap a write: refuse it when its acting session is archived, and audit its outcome."""

    @functools.wraps(method)
    async def write(self: Service, request: BaseModel, caller: Caller):
        try:
            if spec.name != "session_archive":
                self._refuse_archived(getattr(request, "session", None))
            result = await method(self, request, caller)
        except OperationError as error:
            self._audit(spec, request, caller, getattr(request, spec.subject, None), error.code)
            raise
        self._audit(spec, request, caller, _target(result), "ok")
        return result

    return write


# Every write goes through `_write`, driven by the contract so that no write can be left out.
for _spec in OPERATIONS:
    if _spec.writes:
        setattr(Service, _spec.name, _write(_spec, getattr(Service, _spec.name)))

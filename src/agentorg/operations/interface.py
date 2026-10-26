"""The service layer: every operation on the record, which the API, MCP and the page all call."""

import inspect
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import get_type_hints

from pydantic import BaseModel

from agentorg.models import (
    Ask,
    AskAnswer,
    AskGet,
    AskList,
    AskListResult,
    AskOpen,
    AskRecordAnswer,
    AskWait,
    AuditList,
    AuditListResult,
    Channel,
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
    Resource,
    Session,
    SessionArchive,
    SessionArchiveResult,
    SessionDeclareRole,
    SessionList,
    SessionListResult,
    SessionRegister,
    SessionStart,
    SessionStartResult,
    Task,
    TaskClose,
    TaskList,
    TaskListResult,
    TaskOpen,
)


@dataclass(frozen=True)
class Caller:
    """Who is calling, as the transport tells it. The acting session is in the request itself."""

    channel: Channel
    client: str | None = None
    client_session_id: str | None = None


@dataclass(frozen=True)
class OperationSpec:
    """One operation as every surface derives it.

    `name` (such as `ask_open`) is the method, the MCP tool name and the OpenAPI operation id. The
    API serves it at `POST /api/{subject}/{verb}`, and the CLI as `agentorg {subject} {verb}`.
    """

    name: str
    subject: str
    verb: str
    request: type[BaseModel]
    response: type[BaseModel]
    agent: bool
    writes: bool
    description: str


def operation(*, agent: bool, writes: bool) -> Callable[[Callable], Callable]:
    """Mark a method of `Operations` as an operation. `agent` exposes it as an MCP tool, and
    `writes` records each call in the audit log."""

    def mark(method: Callable) -> Callable:
        method.__agentorg_operation__ = (agent, writes)
        return method

    return mark


class Operations(ABC):
    """Every operation on the record. Methods marked with `operation` are the contract's
    operations; the rest serve the decisions page's sign-in.

    Each operation takes its request model and the caller, and returns its response model or
    raises an `OperationError`.
    """

    # Sessions

    @operation(agent=True, writes=True)
    @abstractmethod
    async def session_start(self, request: SessionStart, caller: Caller) -> SessionStartResult:
        """Start a session, or resume it, and return the facts it acts on.

        Call it first. It returns the session's id, its parent, its task, its own asks that are
        open or answered, and the reports to it not yet acknowledged. Starting again with the same
        client and client session id resumes the same session.
        """

    @operation(agent=True, writes=True)
    @abstractmethod
    async def session_declare_role(self, request: SessionDeclareRole, caller: Caller) -> Session:
        """Record the role the session declares: it manages or it executes."""

    @operation(agent=True, writes=True)
    @abstractmethod
    async def session_register(self, request: SessionRegister, caller: Caller) -> Resource:
        """Register something the session created, such as a worktree or a page, so that
        archiving the session lists it for cleanup."""

    @operation(agent=True, writes=True)
    @abstractmethod
    async def session_archive(
        self, request: SessionArchive, caller: Caller
    ) -> SessionArchiveResult:
        """Archive a session and return its cleanup list.

        The list holds the items and evidence recorded against the session and the resources it
        registered. Its manager clears them.
        """

    @operation(agent=False, writes=False)
    @abstractmethod
    async def session_list(self, request: SessionList, caller: Caller) -> SessionListResult:
        """List sessions, oldest first."""

    # Tasks

    @operation(agent=True, writes=True)
    @abstractmethod
    async def task_open(self, request: TaskOpen, caller: Caller) -> Task:
        """Open a task. Asks and items belong to a task, and the page groups them by its project."""

    @operation(agent=True, writes=True)
    @abstractmethod
    async def task_close(self, request: TaskClose, caller: Caller) -> Task:
        """Close a task."""

    @operation(agent=False, writes=False)
    @abstractmethod
    async def task_list(self, request: TaskList, caller: Caller) -> TaskListResult:
        """List tasks, oldest first."""

    # Asks

    @operation(agent=True, writes=True)
    @abstractmethod
    async def ask_open(self, request: AskOpen, caller: Caller) -> Ask:
        """Ask the user for a decision. It appears on the decisions page until answered.

        Give the context a reader outside the session needs, two to six options, and the label of
        the option you recommend. Then wait for the answer with ask_wait, or keep working and read
        it later with ask_get.
        """

    @operation(agent=True, writes=False)
    @abstractmethod
    async def ask_get(self, request: AskGet, caller: Caller) -> Ask:
        """Read an ask, with its answer once it has one."""

    @operation(agent=True, writes=False)
    @abstractmethod
    async def ask_wait(self, request: AskWait, caller: Caller) -> Ask:
        """Wait until an ask is answered and return it.

        With a timeout, return the ask after that long even if it is still open.
        """

    @operation(agent=True, writes=True)
    @abstractmethod
    async def ask_record_answer(self, request: AskRecordAnswer, caller: Caller) -> Ask:
        """Record an answer the user gave in the asking session's own conversation.

        Quote the user's words exactly. Only the session that opened the ask may record its answer.
        """

    @operation(agent=False, writes=True)
    @abstractmethod
    async def ask_answer(self, request: AskAnswer, caller: Caller) -> Ask:
        """Answer an ask as the user, with a choice, a note in the user's words, or both."""

    @operation(agent=False, writes=False)
    @abstractmethod
    async def ask_list(self, request: AskList, caller: Caller) -> AskListResult:
        """List asks, oldest first."""

    # Items

    @operation(agent=True, writes=True)
    @abstractmethod
    async def item_put(self, request: ItemPut, caller: Caller) -> Item:
        """Create an open item, a workstream with its state, or replace one.

        Keep the summary short; it is a status, not a log.
        """

    @operation(agent=True, writes=True)
    @abstractmethod
    async def item_resolve(self, request: ItemResolve, caller: Caller) -> Item:
        """Resolve an item, which removes it from the open workstreams."""

    @operation(agent=False, writes=False)
    @abstractmethod
    async def item_list(self, request: ItemList, caller: Caller) -> ItemListResult:
        """List items, open ones only unless asked otherwise, oldest first."""

    # Reports

    @operation(agent=True, writes=True)
    @abstractmethod
    async def report_send(self, request: ReportSend, caller: Caller) -> Report:
        """Send a report to the session's parent. It stays in the parent's inbox until the parent
        acknowledges it."""

    @operation(agent=True, writes=False)
    @abstractmethod
    async def inbox_read(self, request: InboxRead, caller: Caller) -> Inbox:
        """Read the reports to the session that it has not acknowledged."""

    @operation(agent=True, writes=True)
    @abstractmethod
    async def report_ack(self, request: ReportAck, caller: Caller) -> Report:
        """Acknowledge a report, after reviewing it. Only its recipient may."""

    # Audit

    @operation(agent=False, writes=False)
    @abstractmethod
    async def audit_list(self, request: AuditList, caller: Caller) -> AuditListResult:
        """List audit entries, newest first."""

    # Decisions page sign-in

    @operation(agent=False, writes=True)
    @abstractmethod
    async def ui_login_link(self, request: LoginLinkCreate, caller: Caller) -> LoginLink:
        """Mint a one-time link that signs the browser in to the decisions page."""

    @abstractmethod
    async def redeem_login_token(self, token: str) -> PageSession:
        """Use up a login link's token and start a page session. Raises `Invalid` for a token
        that is unknown, used or expired."""

    @abstractmethod
    async def get_page_session(self, session_id: str) -> PageSession | None:
        """The page session with this id, or None when it is unknown or expired."""


def _unwrap(docstring: str) -> str:
    """Join each paragraph's wrapped lines, so every surface can wrap the text its own way."""
    return "\n\n".join(" ".join(p.split()) for p in docstring.split("\n\n"))


def _specs() -> tuple[OperationSpec, ...]:
    specs = []
    for name, method in vars(Operations).items():
        marker = getattr(method, "__agentorg_operation__", None)
        if marker is None:
            continue
        agent, writes = marker
        hints = get_type_hints(method)
        subject, verb = name.split("_", 1)
        specs.append(
            OperationSpec(
                name=name,
                subject=subject,
                verb=verb,
                request=hints["request"],
                response=hints["return"],
                agent=agent,
                writes=writes,
                description=_unwrap(inspect.getdoc(method) or ""),
            )
        )
    return tuple(specs)


OPERATIONS: tuple[OperationSpec, ...] = _specs()

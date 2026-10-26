"""Sessions: the hierarchy as data. A role is recorded as a session declares it, not assigned."""

from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from agentorg.models.ask import Ask
from agentorg.models.common import ContractModel, Id, Ref, Short, Timestamp, Title
from agentorg.models.evidence import Evidence
from agentorg.models.item import Item
from agentorg.models.report import Report
from agentorg.models.task import Task

Role = Literal["manages", "executes"]

ClientKind = Annotated[
    str, StringConstraints(min_length=1, max_length=40, pattern=r"^[a-z0-9][a-z0-9._-]*$")
]


class Session(ContractModel):
    id: Id = Field(description="Issued by the service.")
    client: ClientKind = Field(description='The client kind, such as "claude-code" or "codex".')
    client_session_id: Short | None = Field(description="The client's own id for the session.")
    title: Title
    parent: Id | None = Field(description="The parent session; null when the user is the parent.")
    task: Id | None
    role: Role | None = Field(description="The role as the session declared it.")
    machine: Short
    started_at: Timestamp
    archived_at: Timestamp | None


class Resource(ContractModel):
    """Something a session registered so that archiving it lists it for cleanup."""

    session: Id
    kind: Short = Field(description='What it is, such as "worktree", "branch" or "page".')
    ref: Ref = Field(description="Where it is: a path or a URL.")
    registered_at: Timestamp


class SessionStart(ContractModel):
    client: ClientKind | None = Field(
        default=None, description="Defaults to the client the transport names."
    )
    client_session_id: Short | None = Field(
        default=None,
        description="Defaults to the one the transport carries. Starting again with the same "
        "client and client session id resumes that session.",
    )
    title: Title
    parent: Id | None = Field(default=None, description="The parent session's id.")
    task: Id | None = None
    machine: Short | None = Field(default=None, description="Defaults to the service's host name.")


class SessionStartResult(ContractModel):
    """Facts only: the skill decides the session's role from them."""

    session: Session
    parent: Session | None
    task: Task | None
    asks: list[Ask] = Field(description="The session's own asks that are open or answered.")
    inbox: list[Report] = Field(description="Reports to the session not yet acknowledged.")


class SessionDeclareRole(ContractModel):
    session: Id
    role: Role


class SessionRegister(ContractModel):
    session: Id
    kind: Short
    ref: Ref


class SessionArchive(ContractModel):
    session: Id = Field(description="The session to archive.")


class SessionArchiveResult(ContractModel):
    """The cleanup list for the manager that archives the session."""

    session: Session
    items: list[Item]
    evidence: list[Evidence]
    resources: list[Resource]


class SessionList(ContractModel):
    include_archived: bool = False


class SessionListResult(ContractModel):
    sessions: list[Session]

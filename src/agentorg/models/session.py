"""Sessions: the hierarchy as data."""

from typing import Annotated

from pydantic import Field, StringConstraints

from agentorg.models.common import ContractModel, Id, Short, Timestamp, Title

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
    machine: Short
    started_at: Timestamp
    archived_at: Timestamp | None


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


class SessionContext(ContractModel):
    client: ClientKind | None = Field(
        default=None, description="Defaults to the client the transport names."
    )
    client_session_id: Short | None = Field(
        default=None, description="Defaults to the one the transport carries."
    )


class SessionArchive(ContractModel):
    session: Id = Field(description="The session to archive.")

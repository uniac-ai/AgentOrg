"""The audit trail: every write, with who made it and through which surface."""

from typing import Literal

from pydantic import Field

from agentorg.models.common import ContractModel, Id, Short, Timestamp

Channel = Literal["mcp", "api", "page"]


class AuditEntry(ContractModel):
    id: int
    at: Timestamp
    session: Id | None = Field(description="The acting session, when the request names one.")
    client: Short | None
    operation: Short
    target: Id | None = Field(description="The record the operation acted on.")
    channel: Channel
    outcome: Short = Field(description='"ok", or the error code the operation returned.')


class AuditList(ContractModel):
    session: Id | None = None
    limit: int = Field(default=100, ge=1, le=1000)


class AuditListResult(ContractModel):
    entries: list[AuditEntry] = Field(description="Newest first.")

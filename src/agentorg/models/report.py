"""Reports: a durable mailbox from a child session to its parent."""

from typing import Annotated

from pydantic import Field, StringConstraints

from agentorg.models.common import OUTCOME_MAX, ContractModel, Id, Timestamp

Outcome = Annotated[str, StringConstraints(min_length=1, max_length=OUTCOME_MAX)]


class Report(ContractModel):
    id: Id
    sender: Id = Field(description="The reporting session.")
    recipient: Id | None = Field(description="The sender's parent session; null for the user.")
    outcome: Outcome = Field(description="Markdown, organized at the sender's level.")
    open_asks: list[Id] = Field(description="The sender's asks still open when it reported.")
    evidence: list[Id]
    sent_at: Timestamp
    acknowledged_at: Timestamp | None


class ReportSend(ContractModel):
    session: Id = Field(description="The reporting session; the report goes to its parent.")
    outcome: Outcome
    evidence: list[Id] = Field(default_factory=list)


class InboxRead(ContractModel):
    session: Id


class Inbox(ContractModel):
    reports: list[Report] = Field(description="Reports to the session not yet acknowledged.")


class ReportAck(ContractModel):
    session: Id = Field(description="The recipient; acknowledging is its review of the report.")
    report: Id

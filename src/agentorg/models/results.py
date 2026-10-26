"""Results that bring together records of several subjects for one reader."""

from pydantic import Field

from agentorg.models.ask import Ask
from agentorg.models.common import ContractModel
from agentorg.models.evidence import Evidence
from agentorg.models.item import Item
from agentorg.models.report import Report
from agentorg.models.session import Session
from agentorg.models.task import Task


class SessionFacts(ContractModel):
    """What a session acts on, facts only: the skill decides the session's role from them."""

    session: Session
    parent: Session | None
    task: Task | None
    asks: list[Ask] = Field(description="The session's own asks that are open or answered.")
    inbox: list[Report] = Field(description="Reports to the session not yet acknowledged.")


class SessionContextResult(ContractModel):
    facts: SessionFacts | None = Field(
        description="Null when no session was started with this client session id."
    )


class SessionArchiveResult(ContractModel):
    """The cleanup list for the manager that archives the session."""

    session: Session
    items: list[Item] = Field(description="The session's open items.")
    evidence: list[Evidence] = Field(description="The evidence of the session's items.")
    withdrawn_asks: list[Ask] = Field(description="The open asks that archiving withdrew.")


class AskListResult(ContractModel):
    asks: list[Ask]
    tasks: list[Task] = Field(description="The tasks the asks belong to.")
    sessions: list[Session] = Field(description="The sessions that asked.")


class ItemListResult(ContractModel):
    items: list[Item]
    tasks: list[Task] = Field(description="The tasks the items belong to.")
    sessions: list[Session] = Field(description="The sessions doing the work.")

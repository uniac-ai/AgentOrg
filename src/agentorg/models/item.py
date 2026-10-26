"""Items: open workstreams. Resolving one removes it, so only open items show."""

from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from agentorg.models.common import SUMMARY_MAX, ContractModel, Id, Link, Short, Timestamp, Title

ItemState = Literal["waiting", "review", "running", "blocked"]

Summary = Annotated[str, StringConstraints(max_length=SUMMARY_MAX)]


class Item(ContractModel):
    id: Id
    task: Id | None
    session: Id | None = Field(description="The session doing the work.")
    title: Title
    state: ItemState
    summary: Summary = Field(description="Short Markdown.")
    links: list[Link]
    evidence: list[Id]
    blockers: list[Short] = Field(description="Who unblocks the item.")
    updated_at: Timestamp
    resolved_at: Timestamp | None


class ItemPut(ContractModel):
    item: Id | None = Field(
        default=None, description="The item to replace; omit to create a new one."
    )
    session: Id | None = Field(default=None, description="The session doing the work.")
    task: Id | None = Field(default=None, description="Defaults to the session's task.")
    title: Title
    state: ItemState
    summary: Summary = Field(default="", description="Short Markdown; no logs.")
    links: list[Link] = Field(default_factory=list, max_length=20)
    blockers: list[Short] = Field(default_factory=list, max_length=10)


class ItemResolve(ContractModel):
    item: Id
    session: Id | None = Field(
        default=None, description="The session resolving it; omit when the user does."
    )


class ItemList(ContractModel):
    task: Id | None = None
    include_resolved: bool = False

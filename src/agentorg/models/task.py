"""Tasks: the unit of work that asks and items belong to."""

from typing import Literal

from pydantic import Field

from agentorg.models.common import ContractModel, Id, Short, Timestamp, Title

TaskState = Literal["open", "closed"]


class Task(ContractModel):
    id: Id
    title: Title
    project: Short = Field(description="Free text naming where the work lives: a repo, an area.")
    owner: Id | None = Field(description="The session that owns the task; null when the user does.")
    parent: Id | None = Field(description="The task this one is part of.")
    state: TaskState
    opened_at: Timestamp
    closed_at: Timestamp | None


class TaskOpen(ContractModel):
    session: Id | None = Field(
        default=None, description="The session that owns the task; omit when the user opens it."
    )
    title: Title
    project: Short
    parent: Id | None = None


class TaskClose(ContractModel):
    task: Id
    session: Id | None = Field(
        default=None, description="The session closing the task; omit when the user closes it."
    )

"""What the decisions page shows: open asks and open items, grouped by project and task.

The routes build a `Page` from the service layer, and the views render it.
"""

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Generic, Protocol, TypeVar

from agentorg.models import Ask, Item, Session, Task


class InTask(Protocol):
    task: str | None


R = TypeVar("R", bound=InTask)


@dataclass(frozen=True)
class TaskGroup(Generic[R]):
    task: Task | None
    entries: list[R]


@dataclass(frozen=True)
class ProjectGroup(Generic[R]):
    project: str | None
    tasks: list[TaskGroup[R]]


def group(
    records: Sequence[R], tasks: Iterable[Task], key: Callable[[R], datetime]
) -> list[ProjectGroup[R]]:
    """Group records by project, then by task, oldest first.

    Records within a task are ordered by `key`, and each group comes in the order of its oldest
    record, so the record that has waited longest is first on the page. A record without a known
    task falls in a group whose project and task are None.
    """
    tasks_by_id = {task.id: task for task in tasks}
    projects: dict[str | None, dict[str | None, TaskGroup[R]]] = {}
    for record in sorted(records, key=key):
        task = tasks_by_id.get(record.task) if record.task else None
        project = projects.setdefault(task.project if task else None, {})
        project.setdefault(task.id if task else None, TaskGroup(task, [])).entries.append(record)
    return [ProjectGroup(name, list(by_task.values())) for name, by_task in projects.items()]


def count(projects: Iterable[ProjectGroup]) -> int:
    return sum(len(group.entries) for project in projects for group in project.tasks)


@dataclass(frozen=True)
class Refusal:
    """An answer the service refused, shown on its ask with what the user had entered."""

    ask: str
    message: str
    choice: str | None
    words: str | None


@dataclass(frozen=True)
class Page:
    asks: list[ProjectGroup[Ask]]
    items: list[ProjectGroup[Item]]
    sessions: dict[str, Session]
    csrf_token: str
    settled: Ask | None = None
    """The ask the user just answered, read back to show what was recorded."""
    refusal: Refusal | None = None

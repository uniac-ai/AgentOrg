from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from agentorg.models import Task
from agentorg.page.model import count, group

NOW = datetime(2026, 1, 1, tzinfo=UTC)


@dataclass
class Record:
    name: str
    task: str | None
    minutes_ago: int

    @property
    def at(self):
        return NOW - timedelta(minutes=self.minutes_ago)


def task(id, project):
    return Task(
        id=id,
        title=id,
        project=project,
        owner=None,
        parent=None,
        state="open",
        opened_at=NOW,
        closed_at=None,
    )


def shape(projects):
    return [
        (p.project, [(t.task.id if t.task else None, [r.name for r in t.entries]) for t in p.tasks])
        for p in projects
    ]


def test_records_group_by_project_and_task_with_the_longest_waiting_first():
    tasks = [task("docs", "site"), task("store", "api"), task("auth", "api")]
    records = [
        Record("store-new", "store", 5),
        Record("docs-only", "docs", 30),
        Record("auth-only", "auth", 90),
        Record("store-old", "store", 120),
    ]

    grouped = group(records, tasks, key=lambda record: record.at)

    assert shape(grouped) == [
        ("api", [("store", ["store-old", "store-new"]), ("auth", ["auth-only"])]),
        ("site", [("docs", ["docs-only"])]),
    ]
    assert count(grouped) == 4


def test_records_without_a_known_task_share_one_group():
    records = [Record("no-task", None, 10), Record("unknown-task", "gone", 20)]

    grouped = group(records, [task("store", "api")], key=lambda record: record.at)

    assert shape(grouped) == [(None, [(None, ["unknown-task", "no-task"])])]


def test_nothing_to_group_is_no_groups():
    assert group([], [], key=lambda record: record.at) == []
    assert count([]) == 0

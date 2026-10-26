import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest

from agentorg.home import database_path, home
from agentorg.models import Answer, Ask, Option, Session
from agentorg.store import TABLES, Store

T0 = datetime(2026, 1, 1, tzinfo=UTC)


@pytest.fixture
def store(tmp_path):
    store = Store(tmp_path / "agentorg.db")
    yield store
    store.close()


def session(**changes):
    fields = dict(
        id="ses_1",
        client="codex",
        client_session_id=None,
        title="Build",
        parent=None,
        task=None,
        machine="laptop",
        started_at=T0,
        archived_at=None,
    )
    return Session(**(fields | changes))


def test_the_database_is_in_wal_mode_with_foreign_keys(store):
    assert store.execute("PRAGMA journal_mode")[0][0] == "wal"
    assert store.execute("PRAGMA foreign_keys")[0][0] == 1


def test_every_table_has_a_column_per_field_of_its_record(store):
    for model, table in TABLES.items():
        columns = [row["name"] for row in store.execute(f"PRAGMA table_info({table})")]
        assert columns == list(model.model_fields), table


def test_a_record_with_nested_fields_comes_back_unchanged(store):
    store.insert(session())
    ask = Ask(
        id="ask_1",
        task=None,
        session="ses_1",
        title="Which database?",
        context="Both fit.",
        options=[Option(label="SQLite"), Option(label="Postgres", detail="Needs a server.")],
        recommendation="SQLite",
        state="open",
        answer=None,
        opened_at=T0,
    )
    store.insert(ask)
    assert store.get(Ask, "ask_1") == ask

    answered = ask.model_copy(
        update={
            "state": "answered",
            "answer": Answer(choice="SQLite", words=None, channel="page", answered_at=T0),
        }
    )
    store.update(answered)
    assert store.get(Ask, "ask_1") == answered
    assert store.get(Ask, "ask_2") is None


def test_a_reference_to_a_missing_record_is_refused(store):
    store.insert(session())
    with pytest.raises(sqlite3.IntegrityError):
        store.insert(session(id="ses_2", parent="ses_404"))


def test_a_failed_transaction_leaves_nothing(store):
    with pytest.raises(RuntimeError), store.transaction():
        store.insert(session())
        raise RuntimeError("stop")
    assert store.select(Session) == []


def test_select_orders_and_limits(store):
    for n in range(3):
        store.insert(session(id=f"ses_{n}"))
    assert [s.id for s in store.select(Session)] == ["ses_0", "ses_1", "ses_2"]
    assert [s.id for s in store.select(Session, order="rowid DESC", limit=2)] == [
        "ses_2",
        "ses_1",
    ]


def test_reopening_keeps_the_record_and_a_newer_schema_is_refused(tmp_path):
    path = tmp_path / "agentorg.db"
    first = Store(path)
    first.insert(session())
    first.close()
    second = Store(path)
    assert second.get(Session, "ses_1") is not None
    second.execute("PRAGMA user_version = 99")
    second.close()
    with pytest.raises(RuntimeError, match="schema 99"):
        Store(path)


def test_the_home_is_overridable(monkeypatch, tmp_path):
    monkeypatch.delenv("AGENTORG_HOME", raising=False)
    assert home() == Path.home() / ".local/share/agentorg"
    monkeypatch.setenv("AGENTORG_HOME", str(tmp_path))
    assert database_path() == tmp_path / "agentorg.db"

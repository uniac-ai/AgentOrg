import pytest
from pydantic import ValidationError

from agentorg.models import AskAnswer, AskOpen, ItemPut, SessionStart


def ask(**changes):
    fields = {
        "session": "ses_1",
        "title": "Which database?",
        "context": "The service needs one store. Both options fit the load.",
        "options": [{"label": "SQLite"}, {"label": "Postgres", "detail": "Needs a server."}],
        "recommendation": "SQLite",
    }
    fields.update(changes)
    return AskOpen.model_validate(fields)


def test_a_complete_ask_is_accepted():
    request = ask(title="  Which database?  ")
    assert request.title == "Which database?"
    assert [option.label for option in request.options] == ["SQLite", "Postgres"]


@pytest.mark.parametrize(
    "changes",
    [
        {"context": None},
        {"context": "   "},
        {"context": "x" * 1001},
        {"options": [{"label": "SQLite"}]},
        {"options": [{"label": str(n)} for n in range(7)], "recommendation": "1"},
        {"options": [{"label": "SQLite"}, {"label": "SQLite"}]},
        {"recommendation": "MySQL"},
        {"recommendation": None},
        {"session": None},
        {"unknown": "field"},
    ],
)
def test_an_ask_without_context_options_or_a_recommendation_is_refused(changes):
    with pytest.raises(ValidationError):
        ask(**changes)


def test_an_answer_needs_a_choice_or_words():
    with pytest.raises(ValidationError):
        AskAnswer(ask="ask_1")
    assert AskAnswer(ask="ask_1", words="Use SQLite for now").choice is None
    assert AskAnswer(ask="ask_1", choice="SQLite").words is None


def test_an_item_needs_a_known_state_and_a_short_summary():
    with pytest.raises(ValidationError):
        ItemPut(title="Store")
    with pytest.raises(ValidationError):
        ItemPut(title="Store", state="done")
    with pytest.raises(ValidationError):
        ItemPut(title="Store", state="running", summary="x" * 2001)
    assert ItemPut(title="Store", state="running").summary == ""


def test_a_client_kind_is_a_plain_identifier():
    assert SessionStart(title="Build", client="claude-code").client == "claude-code"
    with pytest.raises(ValidationError):
        SessionStart(title="Build", client="Claude Code")

import pytest

from agentorg.models import Answer

CSRF = "csrf_1"


@pytest.fixture
def open_ask(operations):
    operations.add_task("tsk_1", "api")
    operations.add_ask("ask_1", "tsk_1", 30, labels=("Keep", "Delete"), title="Keep the files?")
    return operations.asks["ask_1"]


def answer(client, ask="ask_1", **form):
    return client.post(f"/ui/asks/{ask}/answer", data=form, follow_redirects=False)


def test_an_answer_reaches_the_service_layer_on_the_page_channel(signed_in, operations, open_ask):
    response = answer(signed_in, csrf=CSRF, choice="Delete", words="  Measure it first.  ")

    assert response.status_code == 303
    assert response.headers["location"] == "/?answered=ask_1"
    [(request, caller)] = operations.answers
    assert (request.ask, request.choice, request.words) == ("ask_1", "Delete", "Measure it first.")
    assert caller.channel == "page"


def test_the_page_then_confirms_what_was_recorded_and_no_longer_lists_the_ask(signed_in, open_ask):
    page = signed_in.get(answer(signed_in, csrf=CSRF, choice="Delete").headers["location"])

    assert page.status_code == 200
    assert 'class="settled"' in page.text
    assert "Answered: Delete" in page.text
    assert 'id="ask-ask_1"' not in page.text
    assert "Nothing is waiting on you" in page.text


def test_a_note_alone_is_an_answer(signed_in, operations, open_ask):
    assert answer(signed_in, csrf=CSRF, words="Neither; ask me tomorrow.").status_code == 303
    [(request, _)] = operations.answers
    assert (request.choice, request.words) == (None, "Neither; ask me tomorrow.")


@pytest.mark.parametrize("csrf", [None, "", "csrf_2", "csrf_1x"])
def test_an_answer_without_the_page_sessions_csrf_token_is_refused(
    signed_in, operations, open_ask, csrf
):
    form = {"choice": "Keep"} if csrf is None else {"csrf": csrf, "choice": "Keep"}

    response = answer(signed_in, **form)

    assert response.status_code == 403
    assert "This page was out of date." in response.text
    assert operations.answers == []


def test_an_answer_without_a_page_session_is_refused(client, operations, open_ask):
    response = answer(client, csrf=CSRF, choice="Keep")

    assert response.status_code == 401
    assert "The answer was not sent." in response.text
    assert operations.answers == []


def test_an_empty_answer_is_refused_on_its_ask(signed_in, operations, open_ask):
    response = answer(signed_in, csrf=CSRF, words="   ")

    assert response.status_code == 422
    assert "Choose an option or write a note." in response.text
    assert 'id="ask-ask_1"' in response.text
    assert operations.answers == []


def test_a_refused_answer_keeps_what_the_user_entered(signed_in, open_ask):
    response = answer(signed_in, csrf=CSRF, choice="Archive", words="My <b>note</b>")

    assert response.status_code == 422
    assert "&#39;Archive&#39; is not one of the ask&#39;s options" in response.text
    assert ">My &lt;b&gt;note&lt;/b&gt;</textarea>" in response.text


def test_a_choice_kept_after_a_refusal_is_checked_again(signed_in, operations, open_ask):
    response = answer(signed_in, csrf=CSRF, choice="Keep", words="x" * 4001)

    assert response.status_code == 422
    assert "at most 4000 characters" in response.text
    assert 'value="Keep" checked' in response.text
    assert operations.answers == []


def test_an_ask_answered_meanwhile_shows_the_answer_on_record(signed_in, operations, open_ask):
    recorded = Answer(
        choice="Keep", words="Keep them.", channel="session", answered_at=open_ask.opened_at
    )
    operations.asks["ask_1"] = open_ask.model_copy(update={"state": "answered", "answer": recorded})

    response = answer(signed_in, csrf=CSRF, choice="Delete")
    page = signed_in.get(response.headers["location"])

    assert response.status_code == 303
    assert "Answered in the session: Keep" in page.text
    assert "Keep them." in page.text


def test_an_unknown_ask_is_not_found(signed_in, operations):
    assert answer(signed_in, ask="ask_404", csrf=CSRF, choice="Keep").status_code == 404

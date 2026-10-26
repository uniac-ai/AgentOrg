import re

from agentorg.models import Link


def positions(text, *needles):
    return [text.index(needle) for needle in needles]


def test_asks_show_grouped_by_project_and_task_with_the_longest_waiting_first(
    signed_in, operations
):
    operations.add_session("ses_2", "Guide writer")
    operations.add_task("tsk_docs", "docs-site", "Publish the guide")
    operations.add_task("tsk_store", "example-api", "Move storage to SQLite")
    operations.add_ask("ask_new", "tsk_store", 5)
    operations.add_ask("ask_docs", "tsk_docs", 60, session="ses_2")
    operations.add_ask("ask_old", "tsk_store", 120)

    page = signed_in.get("/").text

    order = positions(
        page,
        "example-api",
        "Move storage to SQLite",
        'id="ask-ask_old"',
        'id="ask-ask_new"',
        "docs-site",
        "Publish the guide",
        'id="ask-ask_docs"',
    )
    assert order == sorted(order)
    assert "<title>(3) Decisions · agentorg</title>" in page
    assert "Asked by Guide writer" in page
    assert "Asked by Storage migration" in page


def test_an_ask_shows_its_options_with_the_recommendation_marked_and_the_csrf_token(
    signed_in, operations
):
    operations.add_ask("ask_1", None, 10, labels=("Keep", "Delete"), recommendation="Delete")

    page = signed_in.get("/").text

    form = page[page.index('<form method="post" action="/ui/asks/ask_1/answer">') :]
    assert '<input type="hidden" name="csrf" value="csrf_1">' in form
    labels = re.findall(r'<label class="option">(.*?)</label>', form, re.S)
    assert ["Recommended" in label for label in labels] == [False, True]
    assert "No project" in page and "No task" in page


def test_text_from_agents_is_escaped(signed_in, operations):
    operations.add_task("tsk_1", "<i>project</i>", "<b>task</b>")
    operations.add_ask(
        "ask_1",
        "tsk_1",
        10,
        title="<script>alert(1)</script>",
        context='"><img src=x onerror=alert(1)>',
        labels=("<a>", "B"),
    )

    page = signed_in.get("/").text

    assert "<script>alert" not in page and "<img" not in page and "<a>" not in page
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page
    assert "&lt;b&gt;task&lt;/b&gt;" in page


def test_with_nothing_open_the_page_says_so(signed_in):
    page = signed_in.get("/").text

    assert "Nothing is waiting on you" in page
    assert "No open workstreams" in page
    assert "<title>Decisions · agentorg</title>" in page


def test_open_workstreams_show_state_summary_links_and_blockers_by_task(signed_in, operations):
    operations.add_task("tsk_1", "example-api", "Move storage to SQLite")
    operations.add_item(
        "itm_1",
        "tsk_1",
        30,
        title="Backfill on staging",
        state="blocked",
        summary="Waiting for a snapshot.\nThen 40 minutes.",
        blockers=["The user: approve the window"],
        links=[
            Link(label="Pull request", url="https://example.com/pr/12"),
            Link(label="Script", url="javascript:alert(1)"),
        ],
    )

    page = signed_in.get("/").text
    workstreams = page[page.index("Open workstreams") :]

    assert "Move storage to SQLite" in workstreams
    assert '<span class="badge state-blocked">Blocked</span>' in workstreams
    assert "Waiting for a snapshot.\nThen 40 minutes." in workstreams
    assert "The user: approve the window" in workstreams
    assert '<a href="https://example.com/pr/12" target="_blank" rel="noreferrer">' in workstreams
    assert 'href="javascript:' not in workstreams
    assert "Script: javascript:alert(1)" in workstreams

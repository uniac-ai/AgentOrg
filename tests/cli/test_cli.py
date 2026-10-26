import json
import os
import socket
import stat
import subprocess
import sys
import time

import httpx
import pytest

from agentorg.cli import build_parser, main
from agentorg.cli.operations import request
from agentorg.home import ensure_token, read_token

COMMANDS = [
    "session_start",
    "session_context",
    "session_archive",
    "task_open",
    "task_close",
    "ask_open",
    "ask_get",
    "ask_wait",
    "ask_record_answer",
    "ask_withdraw",
    "ask_list",
    "item_put",
    "item_resolve",
    "item_list",
    "report_send",
    "inbox_read",
    "report_ack",
    "audit_list",
    "ui_login_link",
]


@pytest.fixture
def service_env(server_url, token, monkeypatch):
    monkeypatch.setenv("AGENTORG_URL", server_url)
    monkeypatch.setenv("AGENTORG_TOKEN", token)
    return os.environ | {"AGENTORG_URL": server_url, "AGENTORG_TOKEN": token}


def run(capsys, *argv):
    code = main(list(argv))
    captured = capsys.readouterr()
    return code, json.loads(captured.out) if captured.out.strip() else None, captured.err


def agentorg(*argv, env):
    return subprocess.Popen(
        [sys.executable, "-m", "agentorg", *argv],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def test_every_agent_and_api_operation_has_a_command_and_answering_has_none(capsys):
    parser = build_parser()
    for operation in COMMANDS:
        subject, verb = operation.split("_", 1)
        args = parser.parse_args([subject, verb.replace("_", "-")])
        assert args.spec.name == operation
    with pytest.raises(SystemExit):
        parser.parse_args(["ask", "answer", "ask_1", "--choice=A"])


def body(args):
    return request(args).model_dump(exclude_unset=True)


def test_flags_and_json_become_the_request():
    parser = build_parser()
    args = parser.parse_args(
        [
            "ask",
            "open",
            "--session=ses_1",
            "--title=Which?",
            '--options={"label": "A"}',
            '--options={"label": "B"}',
            "--json",
            '{"context": "Both fit.", "recommendation": "B"}',
            "--recommendation=A",
        ]
    )
    assert body(args) == {
        "session": "ses_1",
        "title": "Which?",
        "context": "Both fit.",
        "options": [{"label": "A"}, {"label": "B"}],
        "recommendation": "A",
    }
    assert body(parser.parse_args(["ask", "wait", "ask_1", "--timeout-seconds=5"])) == {
        "ask": "ask_1",
        "timeout_seconds": 5.0,
    }
    assert body(parser.parse_args(["item", "list", "--include-resolved"])) == {
        "include_resolved": True
    }
    blockers = parser.parse_args(
        ["item", "put", "--title=Store", "--state=running", "--blockers=CI", "--blockers=the user"]
    )
    assert body(blockers)["blockers"] == ["CI", "the user"]


def open_ask(capsys):
    code, started, _ = run(capsys, "session", "start", "--client=script", "--title=Build")
    assert code == 0
    code, ask, _ = run(
        capsys,
        "ask",
        "open",
        f"--session={started['session']['id']}",
        "--title=Which database?",
        "--context=The service needs one store.",
        '--options={"label": "SQLite"}',
        '--options={"label": "Postgres"}',
        "--recommendation=SQLite",
    )
    assert code == 0
    return ask


def test_a_background_ask_wait_exits_with_the_answer(capsys, service_env, server_url):
    ask = open_ask(capsys)
    waiting = agentorg("ask", "wait", ask["id"], env=service_env)
    time.sleep(1)
    assert waiting.poll() is None
    httpx.post(
        f"{server_url}/test/answer",
        json={"ask": ask["id"], "choice": "Postgres", "words": "Use Postgres."},
    ).raise_for_status()
    out, err = waiting.communicate(timeout=20)
    assert waiting.returncode == 0, err
    assert json.loads(out)["answer"] == json.loads(out)["answer"] | {
        "choice": "Postgres",
        "words": "Use Postgres.",
        "channel": "page",
    }


def test_ask_wait_with_a_timeout_exits_1_with_the_open_ask(capsys, service_env):
    ask = open_ask(capsys)
    code, waited, err = run(capsys, "ask", "wait", ask["id"], "--timeout-seconds=0.2")
    assert (code, waited["state"]) == (1, "open")
    assert "still open" in err


def test_ask_wait_on_a_withdrawn_ask_exits_2_and_its_help_names_the_codes(capsys, service_env):
    ask = open_ask(capsys)
    code, withdrawn, _ = run(capsys, "ask", "withdraw", ask["id"], f"--session={ask['session']}")
    assert (code, withdrawn["state"]) == (0, "withdrawn")
    code, waited, err = run(capsys, "ask", "wait", ask["id"])
    assert (code, waited["state"]) == (2, "withdrawn")
    assert "withdrawn" in err
    with pytest.raises(SystemExit):
        main(["ask", "wait", "--help"])
    help = " ".join(capsys.readouterr().out.split())
    assert "Exit status: 0 when the ask is answered, 2 when it is withdrawn, 1 when the" in help


def test_session_context_prints_known_facts_and_nothing_otherwise(
    capsys, service_env, monkeypatch, tmp_path
):
    context = ["session", "context", "--client=claude-code", "--client-session-id=cc-hook"]
    code, out, _ = run(capsys, *context)
    assert (code, out) == (1, None)
    code, started, _ = run(capsys, "session", "start", *context[2:], "--title=Build")
    assert code == 0
    code, facts, _ = run(capsys, *context)
    assert (code, facts["session"]["id"]) == (0, started["session"]["id"])

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        closed = probe.getsockname()[1]
    monkeypatch.setenv("AGENTORG_URL", f"http://127.0.0.1:{closed}")
    code, out, err = run(capsys, *context)
    assert (code, out) == (1, None) and "not running" in err
    monkeypatch.delenv("AGENTORG_TOKEN")
    monkeypatch.setenv("AGENTORG_HOME", str(tmp_path / "never-started"))
    code, out, _ = run(capsys, *context)
    assert (code, out) == (1, None)


def test_refusals_and_an_unreachable_service_exit_1(capsys, service_env, monkeypatch):
    code, _, err = run(capsys, "ask", "get", "ask_404")
    assert code == 1 and "not_found" in err
    code, _, err = run(capsys, "ask", "open", "--session=ses_1")
    assert code == 1 and "invalid" in err and "title" in err

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        closed = probe.getsockname()[1]
    monkeypatch.setenv("AGENTORG_URL", f"http://127.0.0.1:{closed}")
    code, _, err = run(capsys, "ask", "list")
    assert code == 1 and "agentorg service not running" in err


def test_ui_prints_and_opens_a_one_time_sign_in_link(capsys, service_env, server_url, monkeypatch):
    opened = []
    monkeypatch.setattr("webbrowser.open", opened.append)
    assert main(["ui"]) == 0
    url = capsys.readouterr().out.strip()
    assert url.startswith(f"{server_url}/ui/login?token=")
    assert opened == [url]


def test_the_token_file_is_private(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTORG_HOME", str(tmp_path))
    monkeypatch.delenv("AGENTORG_TOKEN", raising=False)
    with pytest.raises(FileNotFoundError):
        read_token()
    token = ensure_token()
    assert stat.S_IMODE((tmp_path / "token").stat().st_mode) == 0o600
    assert ensure_token() == read_token() == token
    monkeypatch.setenv("AGENTORG_TOKEN", "from-env")
    assert read_token() == "from-env"
    (tmp_path / "token").chmod(0o644)
    with pytest.raises(PermissionError):
        ensure_token()


def test_serve_creates_its_home_and_serves_on_loopback(tmp_path):
    home = tmp_path / "home"
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    env = os.environ | {"AGENTORG_HOME": str(home)}
    server = agentorg("serve", f"--port={port}", env=env)
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                document = httpx.get(f"http://127.0.0.1:{port}/openapi.json").json()
                break
            except httpx.TransportError:
                assert server.poll() is None, server.communicate()[1]
                assert time.monotonic() < deadline, "serve did not start"
                time.sleep(0.1)
        assert document["info"]["title"] == "agentorg"
        assert stat.S_IMODE(home.stat().st_mode) == 0o700
        assert stat.S_IMODE((home / "token").stat().st_mode) == 0o600
        assert (home / "agentorg.db").exists()
        token = (home / "token").read_text().strip()
        response = httpx.post(
            f"http://127.0.0.1:{port}/api/ask/list",
            json={},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.json() == {"asks": [], "tasks": [], "sessions": []}
    finally:
        server.terminate()
        server.wait(timeout=15)

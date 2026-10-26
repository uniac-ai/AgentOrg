"""The commands that do more than print one call's result: serve, the stdio proxy, the page
sign-in, the long-polling ask wait, and the session context for client hooks."""

import argparse
import os
import sys
import time
import webbrowser

import anyio
import uvicorn

from agentorg.app import create_app
from agentorg.cli.operations import CALLER, call, print_json, request
from agentorg.client import RemoteOperations, Unavailable, port
from agentorg.home import database_path, ensure_home, ensure_token
from agentorg.mcp.proxy import run_proxy
from agentorg.models import Ask, AskWait, LoginLinkCreate
from agentorg.operations.service import Service
from agentorg.store import Store

# How long each request of `agentorg ask wait` waits before asking again.
POLL_SECONDS = 30.0


def add_commands(commands: argparse._SubParsersAction) -> None:
    serve_parser = commands.add_parser("serve", help="run the service on 127.0.0.1")
    serve_parser.add_argument(
        "--port", type=int, default=port(), help="defaults to AGENTORG_PORT or 8740"
    )
    serve_parser.set_defaults(handler=serve)

    mcp_parser = commands.add_parser("mcp", help="serve MCP over stdio, relayed to the service")
    mcp_parser.add_argument("--client", help='the client kind, such as "claude-code"')
    mcp_parser.add_argument(
        "--client-session-env",
        metavar="VARIABLE",
        help="the environment variable holding the client's session id",
    )
    mcp_parser.set_defaults(handler=mcp)


def serve(args: argparse.Namespace) -> int:
    ensure_home()
    token = ensure_token()
    store = Store(database_path())
    try:
        uvicorn.run(create_app(Service(store), token=token), host="127.0.0.1", port=args.port)
    finally:
        store.close()
    return 0


def mcp(args: argparse.Namespace) -> int:
    client_session_id = os.environ.get(args.client_session_env or "") or None
    operations = RemoteOperations(client=args.client, client_session_id=client_session_id)
    anyio.run(run_proxy, operations)
    return 0


def open_page(args: argparse.Namespace) -> int:
    """Open the decisions page, signed in by a one-time link."""

    async def login_link():
        operations = RemoteOperations()
        async with operations.http:
            return operations.url, await operations.ui_login_link(LoginLinkCreate(), CALLER)

    base, link = anyio.run(login_link)
    url = base + link.path
    print(url)
    webbrowser.open(url)
    return 0


def session_context(args: argparse.Namespace) -> int:
    """For a client's session-start hook: prints the facts of a client session already started as
    JSON. Prints nothing on stdout and exits 1 when no session was started with that client
    session id or the service is not running."""
    try:
        result = anyio.run(call, args.spec, request(args))
    except Unavailable as error:
        print(f"agentorg: {error}", file=sys.stderr)
        return 1
    if result.facts is None:
        print("agentorg: no session was started with that client session id", file=sys.stderr)
        return 1
    print_json(result.facts)
    return 0


def ask_wait(args: argparse.Namespace) -> int:
    """Waits for the ask in the background, asking the service again every 30 seconds and across
    its restarts, and prints the ask as JSON when it is settled. Exit status: 0 when the ask is
    answered, 2 when it is withdrawn, 1 when the timeout passes with it still open or on an
    error."""
    ask = anyio.run(_wait, request(args))
    print_json(ask)
    if ask.state == "answered":
        return 0
    state = "still open" if ask.state == "open" else ask.state
    print(f"agentorg: the ask is {state}", file=sys.stderr)
    return 2 if ask.state == "withdrawn" else 1


async def _wait(wait: AskWait) -> Ask:
    deadline = None if wait.timeout_seconds is None else time.monotonic() + wait.timeout_seconds
    retry = 1.0
    operations = RemoteOperations()
    async with operations.http:
        while True:
            step = POLL_SECONDS
            if deadline is not None:
                step = max(min(step, deadline - time.monotonic()), 0.001)
            try:
                ask = await operations.ask_wait(AskWait(ask=wait.ask, timeout_seconds=step), CALLER)
            except Unavailable as error:
                if deadline is not None and time.monotonic() >= deadline:
                    raise
                print(f"agentorg: {error}; trying again in {retry:.0f}s", file=sys.stderr)
                await anyio.sleep(retry)
                retry = min(retry * 2, 30.0)
                continue
            retry = 1.0
            if ask.state != "open" or (deadline is not None and time.monotonic() >= deadline):
                return ask

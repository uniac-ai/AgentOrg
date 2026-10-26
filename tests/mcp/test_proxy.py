import asyncio
import os
import socket
import sys

import httpx
import pytest
from mcp import Client, StdioServerParameters

ASK = {
    "title": "Which database?",
    "context": "The service needs one store.",
    "options": [{"label": "SQLite"}, {"label": "Postgres"}],
    "recommendation": "SQLite",
}


def proxy(url, mode, **env):
    """A client of `agentorg mcp`, run as a stdio server the way an agent's client runs it."""
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "agentorg", "mcp", "--client=claude-code", "--client-session-env=SESSION_VAR"],
        env=os.environ | {"AGENTORG_URL": url, "SESSION_VAR": "cc-p1"} | env,
    )
    return Client(parameters, mode=mode)


@pytest.fixture(params=["auto", "legacy"])
def proxied(request, server_url, token):
    return lambda: proxy(server_url, request.param, AGENTORG_TOKEN=token)


@pytest.mark.anyio
async def test_the_proxy_relays_tools_instructions_and_the_client_session(proxied):
    async with proxied() as client:
        tools = {tool.name for tool in (await client.list_tools()).tools}
        started = await client.call_tool("session_start", {"title": "Build"})
        assert "ask_open" in tools and "ask_answer" not in tools
        assert "session_start" in client.instructions
    session = started.structured_content["session"]
    assert (session["client"], session["client_session_id"]) == ("claude-code", "cc-p1")


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_with_no_service_the_proxy_starts_lists_tools_and_calls_fail(mode, tmp_path):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        closed = f"http://127.0.0.1:{probe.getsockname()[1]}"
    never_started = {"AGENTORG_HOME": str(tmp_path), "AGENTORG_TOKEN": ""}
    async with proxy(closed, mode, **never_started) as client:
        tools = (await client.list_tools()).tools
        result = await asyncio.wait_for(client.call_tool("session_start", {"title": "x"}), 20)
    assert "session_start" in {tool.name for tool in tools}
    assert result.is_error
    assert result.content[0].text == (
        f"unavailable: agentorg service not running at {closed}; start it with `agentorg serve`"
    )


@pytest.mark.anyio
async def test_an_ask_wait_through_the_proxy_returns_once_answered(proxied, server_url):
    async with proxied() as client:
        started = await client.call_tool("session_start", {"title": "Build"})
        session = started.structured_content["session"]["id"]
        ask = (await client.call_tool("ask_open", {"session": session} | ASK)).structured_content

        async def answer_after_a_while():
            await asyncio.sleep(1)
            async with httpx.AsyncClient(base_url=server_url) as page:
                answered = await page.post(
                    "/test/answer", json={"ask": ask["id"], "choice": "SQLite"}
                )
                answered.raise_for_status()

        answering = asyncio.create_task(answer_after_a_while())
        waited = await asyncio.wait_for(
            client.call_tool("ask_wait", {"ask": ask["id"]}),
            timeout=20,
        )
        await answering
    assert waited.structured_content["answer"]["choice"] == "SQLite"

import asyncio

import httpx
import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from agentorg.mcp import server as mcp_server

AGENT_TOOLS = {
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
    "item_put",
    "item_resolve",
    "report_send",
    "inbox_read",
    "report_ack",
}

ASK = {
    "title": "Which database?",
    "context": "The service needs one store.",
    "options": [{"label": "SQLite"}, {"label": "Postgres"}],
    "recommendation": "SQLite",
}


@pytest.fixture(params=["auto", "legacy"])
def connect(request, server_url, auth):
    """Connects as a current client and as one that uses the older initialize handshake."""

    def connect(**headers):
        http = httpx2.AsyncClient(headers=auth | headers)
        transport = streamable_http_client(f"{server_url}/mcp", http_client=http)
        return Client(transport, mode=request.param)

    return connect


def test_the_instructions_fit_every_known_client():
    assert 0 < len(mcp_server.INSTRUCTIONS) < 4096


@pytest.mark.anyio
async def test_agents_get_the_agent_tools_and_the_instructions(connect):
    async with connect() as client:
        tools = (await client.list_tools()).tools
        assert {tool.name for tool in tools} == AGENT_TOOLS
        read_only = {tool.name for tool in tools if tool.annotations.read_only_hint}
        assert read_only == {"session_context", "ask_get", "ask_wait", "inbox_read"}
        assert "session_start" in client.instructions


@pytest.mark.anyio
async def test_a_tool_call_carries_the_client_and_its_session_id(connect):
    headers = {"Agentorg-Client": "claude-code", "Agentorg-Client-Session-Id": "cc-7"}
    async with connect(**headers) as client:
        first = await client.call_tool("session_start", {"title": "Build"})
        again = await client.call_tool("session_start", {"title": "Build"})
    assert not first.is_error
    session = first.structured_content["session"]
    assert (session["client"], session["client_session_id"]) == ("claude-code", "cc-7")
    assert again.structured_content["session"]["id"] == session["id"]


@pytest.mark.anyio
async def test_refusals_come_back_as_tool_errors(connect):
    async with connect() as client:
        invalid = await client.call_tool("ask_open", {"session": "ses_1", "title": "x"})
        missing = await client.call_tool("ask_open", {"session": "ses_404"} | ASK)
        unknown = await client.call_tool("ask_answer", {"ask": "ask_1", "choice": "SQLite"})
    assert invalid.is_error and invalid.content[0].text.startswith("invalid:")
    assert missing.is_error and missing.content[0].text.startswith("not_found:")
    assert unknown.is_error and "unknown tool" in unknown.content[0].text


@pytest.mark.anyio
async def test_ask_wait_reports_progress_until_the_ask_is_answered(
    connect, server_url, auth, monkeypatch
):
    monkeypatch.setattr(mcp_server, "PROGRESS_INTERVAL_SECONDS", 0.1)
    progress = []

    async def on_progress(value, total, message):
        progress.append(value)

    async with connect(**{"Agentorg-Client": "codex"}) as client:
        started = await client.call_tool("session_start", {"title": "Build"})
        session = started.structured_content["session"]["id"]
        ask = (await client.call_tool("ask_open", {"session": session} | ASK)).structured_content

        async def answer_later():
            while len(progress) < 2:
                await asyncio.sleep(0.05)
            async with httpx.AsyncClient(base_url=server_url, headers=auth) as api:
                response = await api.post(
                    "/test/answer", json={"ask": ask["id"], "choice": "Postgres"}
                )
                response.raise_for_status()

        answering = asyncio.create_task(answer_later())
        waited = await asyncio.wait_for(
            client.call_tool("ask_wait", {"ask": ask["id"]}, progress_callback=on_progress),
            timeout=10,
        )
        await answering
    assert waited.structured_content["answer"]["choice"] == "Postgres"
    assert progress[:2] == [1, 2]


@pytest.mark.anyio
async def test_ask_wait_with_a_timeout_returns_the_open_ask(connect):
    async with connect(**{"Agentorg-Client": "codex"}) as client:
        started = await client.call_tool("session_start", {"title": "Build"})
        session = started.structured_content["session"]["id"]
        ask = (await client.call_tool("ask_open", {"session": session} | ASK)).structured_content
        waited = await client.call_tool("ask_wait", {"ask": ask["id"], "timeout_seconds": 0.2})
    assert waited.structured_content["state"] == "open"

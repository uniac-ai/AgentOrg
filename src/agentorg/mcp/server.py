"""The MCP server: one tool per agent operation, derived from `OPERATIONS`, served over
Streamable HTTP at `/mcp`. API and user operations are not tools."""

import time
from collections.abc import Mapping
from importlib.resources import files
from typing import Any

from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPASGIApp, StreamableHTTPSessionManager
from mcp.types import (
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
    TextContent,
    Tool,
    ToolAnnotations,
)
from pydantic import BaseModel, ValidationError

from agentorg import __version__
from agentorg.api import CLIENT_HEADER, CLIENT_SESSION_HEADER
from agentorg.models import AskWait
from agentorg.operations import OPERATIONS, Caller, OperationError, Operations, invalid

INSTRUCTIONS = files(__package__).joinpath("instructions.md").read_text()

# How often a waiting ask_wait reports progress, so that clients do not time the call out.
PROGRESS_INTERVAL_SECONDS = 15.0

AGENT_OPERATIONS = {spec.name: spec for spec in OPERATIONS if spec.kind == "agent"}

TOOLS = [
    Tool(
        name=spec.name,
        description=spec.description,
        input_schema=spec.request.model_json_schema(),
        output_schema=spec.response.model_json_schema(mode="serialization"),
        annotations=ToolAnnotations(read_only_hint=not spec.writes),
    )
    for spec in AGENT_OPERATIONS.values()
]


def _error(text: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=True)


def _caller(headers: Mapping[str, str] | None) -> Caller:
    headers = headers or {}
    return Caller(
        channel="mcp",
        client=headers.get(CLIENT_HEADER.lower()),
        client_session_id=headers.get(CLIENT_SESSION_HEADER.lower()),
    )


def build_server(operations: Operations) -> Server:
    async def list_tools(ctx, params: PaginatedRequestParams | None) -> ListToolsResult:
        return ListToolsResult(tools=TOOLS)

    async def call_tool(ctx, params: CallToolRequestParams) -> CallToolResult:
        spec = AGENT_OPERATIONS.get(params.name)
        if spec is None:
            return _error(f"unknown tool {params.name}")
        try:
            request = spec.request.model_validate(params.arguments or {})
        except ValidationError as error:
            return _error(f"invalid: {invalid(error.errors())}")
        caller = _caller(getattr(ctx.request, "headers", None))
        try:
            if spec.name == "ask_wait":
                result = await _wait_with_progress(operations, request, caller, ctx)
            else:
                result = await getattr(operations, spec.name)(request, caller)
        except OperationError as error:
            return _error(f"{error.code}: {error}")
        return _result(result)

    return Server(
        "agentorg",
        version=__version__,
        instructions=INSTRUCTIONS,
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


def _result(result: BaseModel) -> CallToolResult:
    structured: dict[str, Any] = result.model_dump(mode="json")
    return CallToolResult(
        content=[TextContent(type="text", text=result.model_dump_json())],
        structured_content=structured,
    )


async def _wait_with_progress(operations: Operations, request: AskWait, caller: Caller, ctx):
    """Wait in steps, reporting progress after each step that ends with the ask still open."""
    deadline = (
        None if request.timeout_seconds is None else time.monotonic() + request.timeout_seconds
    )
    steps = 0
    while True:
        step = PROGRESS_INTERVAL_SECONDS
        if deadline is not None:
            step = min(step, max(deadline - time.monotonic(), 0.001))
        ask = await operations.ask_wait(AskWait(ask=request.ask, timeout_seconds=step), caller)
        if ask.state != "open" or (deadline is not None and time.monotonic() >= deadline):
            return ask
        steps += 1
        await ctx.session.report_progress(steps, message="waiting for the user's answer")


def http_endpoint(operations: Operations) -> StreamableHTTPASGIApp:
    """The ASGI endpoint for `/mcp`. Its session manager must run for the app's lifetime."""
    manager = StreamableHTTPSessionManager(app=build_server(operations), stateless=True)
    return StreamableHTTPASGIApp(manager)

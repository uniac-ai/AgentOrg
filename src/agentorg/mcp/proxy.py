"""The stdio proxy, `agentorg mcp`: the same MCP server as `/mcp`, served over stdin and stdout
for clients that only spawn stdio servers, with each tool call performed over the service's API.

The proxy knows no client. Its flags name the client kind and the environment variable holding
the client's session id, and every call carries both, so a client-provided session id reaches
`session_start` without the agent passing it. When the service is down, the tools still list and
each call fails with `unavailable`.
"""

from mcp.server.stdio import stdio_server

from agentorg.mcp.server import build_server
from agentorg.operations import Operations


async def run_proxy(operations: Operations) -> None:
    server = build_server(operations)
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())

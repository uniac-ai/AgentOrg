"""The app factory: one ASGI app serving the API, MCP, the OpenAPI document and the decisions
page."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from agentorg import __version__, api, page
from agentorg.access import AgentAccess
from agentorg.mcp.server import http_endpoint
from agentorg.operations import Operations


def create_app(operations: Operations, *, token: str) -> FastAPI:
    """Build the app over a service layer. `token` is the bearer token agents present."""
    mcp_endpoint = http_endpoint(operations)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with mcp_endpoint.session_manager.run():
            yield

    app = FastAPI(
        title="agentorg",
        version=__version__,
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.operations = operations
    app.add_middleware(AgentAccess, token=token)
    app.include_router(api.router)
    app.add_route("/mcp", mcp_endpoint)
    app.add_api_route("/openapi.json", api.openapi_document, include_in_schema=False)
    app.include_router(page.router)
    return app

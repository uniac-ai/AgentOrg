"""The app factory: one ASGI app serving the API, the OpenAPI document and the decisions page."""

from fastapi import FastAPI

from agentorg import __version__, api, page
from agentorg.access import AgentAccess
from agentorg.operations import Operations


def create_app(operations: Operations, *, token: str) -> FastAPI:
    """Build the app over a service layer. `token` is the bearer token agents present."""
    app = FastAPI(
        title="agentorg",
        version=__version__,
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
    )
    app.state.operations = operations
    app.add_middleware(AgentAccess, token=token)
    app.include_router(api.router)
    app.add_api_route("/openapi.json", api.openapi_document, include_in_schema=False)
    app.include_router(page.router)
    return app

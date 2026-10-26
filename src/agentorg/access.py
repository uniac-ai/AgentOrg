"""Agent access to the API and MCP surfaces: a bearer token, and no browser requests.

A request that carries an `Origin` header comes from a web page, so it is refused; this blocks
DNS rebinding. The decisions page has its own cookie sign-in and is not covered here.
"""

import secrets

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

AGENT_PATHS = ("/api", "/mcp")


def _is_agent_path(path: str) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in AGENT_PATHS)


class AgentAccess:
    def __init__(self, app: ASGIApp, *, token: str) -> None:
        if not token:
            raise ValueError("the bearer token is empty")
        self.app = app
        self.token = token.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and _is_agent_path(scope["path"]):
            refusal = self._refusal(Headers(scope=scope))
            if refusal is not None:
                await refusal(scope, receive, send)
                return
        await self.app(scope, receive, send)

    def _refusal(self, headers: Headers) -> JSONResponse | None:
        if "origin" in headers:
            return JSONResponse(
                {"code": "forbidden", "message": "requests from web pages are refused"},
                status_code=403,
            )
        scheme, _, credentials = headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(
            credentials.strip().encode(), self.token
        ):
            return JSONResponse(
                {"code": "unauthorized", "message": "a valid bearer token is required"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        return None

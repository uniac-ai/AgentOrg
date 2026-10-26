"""The service as its clients reach it: its address, and every operation over its HTTP API.

A client finds the service at `AGENTORG_URL`, or on 127.0.0.1 at `AGENTORG_PORT` (default 8740).
`RemoteOperations` implements the service-layer interface by calling the API, so the CLI and the
stdio proxy use the same operations, requests and errors as the service itself. It reads the token
on each call, so a client started before the service works once the service is up.
"""

import abc
import os

import httpx
from pydantic import BaseModel

from agentorg.api import API_OPERATIONS, CLIENT_HEADER, CLIENT_SESSION_HEADER
from agentorg.home import read_token
from agentorg.models import PageSession
from agentorg.operations import (
    OPERATIONS,
    Caller,
    Conflict,
    Forbidden,
    Invalid,
    NotFound,
    OperationError,
    Operations,
    OperationSpec,
    invalid,
)

DEFAULT_PORT = 8740

_ERRORS = {error.code: error for error in (NotFound, Invalid, Forbidden, Conflict)}


def port() -> int:
    return int(os.environ.get("AGENTORG_PORT") or DEFAULT_PORT)


def service_url() -> str:
    return (os.environ.get("AGENTORG_URL") or f"http://127.0.0.1:{port()}").rstrip("/")


class Unavailable(OperationError):
    """The service did not answer."""

    code = "unavailable"


class RemoteOperations(Operations):
    """The service's agent and API operations, performed over its HTTP API.

    Every request carries the client kind and client session id given here. User operations are
    not served on the API, so they are not available here.
    """

    def __init__(
        self,
        url: str | None = None,
        token: str | None = None,
        *,
        client: str | None = None,
        client_session_id: str | None = None,
    ) -> None:
        self.url = url or service_url()
        self.token = token
        headers = {}
        if client:
            headers[CLIENT_HEADER] = client
        if client_session_id:
            headers[CLIENT_SESSION_HEADER] = client_session_id
        self.http = httpx.AsyncClient(base_url=self.url, headers=headers)

    def _authorization(self) -> dict[str, str]:
        try:
            return {"Authorization": f"Bearer {self.token or read_token()}"}
        except FileNotFoundError:
            raise self._not_running() from None

    def _not_running(self) -> "Unavailable":
        return Unavailable(
            f"agentorg service not running at {self.url}; start it with `agentorg serve`"
        )

    async def redeem_login_token(self, token: str) -> PageSession:
        raise NotImplementedError("the decisions page signs in on the service itself")

    async def get_page_session(self, session_id: str) -> PageSession | None:
        raise NotImplementedError("the decisions page signs in on the service itself")


def _remote(spec: OperationSpec):
    async def call(self: RemoteOperations, request: BaseModel, caller: Caller) -> BaseModel:
        # A wait holds the request open for its timeout, or until the ask is answered.
        wait = getattr(request, "timeout_seconds", 0.0)
        timeout = httpx.Timeout(10.0, read=None if wait is None else wait + 10.0)
        try:
            response = await self.http.post(
                f"/api/{spec.subject}/{spec.verb}",
                content=request.model_dump_json(exclude_unset=True),
                headers={"Content-Type": "application/json"} | self._authorization(),
                timeout=timeout,
            )
        except httpx.TransportError:
            raise self._not_running() from None
        if response.is_success:
            return spec.response.model_validate(response.json())
        raise _refusal(response)

    call.__name__ = spec.name
    return call


def _refusal(response: httpx.Response) -> OperationError:
    try:
        body = response.json()
    except ValueError:
        return OperationError(f"HTTP {response.status_code}: {response.text}")
    if isinstance(body, dict) and isinstance(body.get("detail"), list):
        return invalid(body["detail"])
    if isinstance(body, dict) and "code" in body:
        error = _ERRORS.get(body["code"])
        message = body.get("message", "")
        return error(message) if error else OperationError(f"{body['code']}: {message}")
    return OperationError(f"HTTP {response.status_code}: {body}")


def _not_served(spec: OperationSpec):
    async def call(self: RemoteOperations, request: BaseModel, caller: Caller) -> BaseModel:
        raise NotImplementedError(f"{spec.name} is served only to the decisions page")

    call.__name__ = spec.name
    return call


for _spec in OPERATIONS:
    remote = _remote if _spec in API_OPERATIONS else _not_served
    setattr(RemoteOperations, _spec.name, remote(_spec))
abc.update_abstractmethods(RemoteOperations)

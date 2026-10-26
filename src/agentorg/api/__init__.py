"""The HTTP JSON API: one `POST /api/{subject}/{verb}` route per agent and API operation,
derived from `OPERATIONS`. User operations are never served here. The OpenAPI document of these
routes is the committed `openapi.json`."""

import inspect
from typing import Any

from fastapi import APIRouter, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse

from agentorg import __version__
from agentorg.models import Channel, ErrorBody
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
)

CLIENT_HEADER = "Agentorg-Client"
CLIENT_SESSION_HEADER = "Agentorg-Client-Session-Id"

ERROR_STATUS: dict[type[OperationError], int] = {
    NotFound: 404,
    Forbidden: 403,
    Conflict: 409,
    Invalid: 422,
}


def get_operations(request: Request) -> Operations:
    """FastAPI dependency: the service layer the app was created with."""
    return request.app.state.operations


def caller_from(request: Request, channel: Channel) -> Caller:
    """The caller of an HTTP request, from the client headers the transport sets."""
    return Caller(
        channel=channel,
        client=request.headers.get(CLIENT_HEADER),
        client_session_id=request.headers.get(CLIENT_SESSION_HEADER),
    )


def error_response(error: OperationError) -> JSONResponse:
    body = ErrorBody(code=error.code, message=str(error))
    return JSONResponse(body.model_dump(), status_code=ERROR_STATUS.get(type(error), 400))


def _endpoint(spec: OperationSpec):
    async def endpoint(request: Request, body: Any) -> Any:
        method = getattr(get_operations(request), spec.name)
        try:
            return await method(body, caller_from(request, "api"))
        except OperationError as error:
            return error_response(error)

    endpoint.__name__ = spec.name
    endpoint.__signature__ = inspect.Signature(
        [
            inspect.Parameter("request", inspect.Parameter.KEYWORD_ONLY, annotation=Request),
            inspect.Parameter("body", inspect.Parameter.KEYWORD_ONLY, annotation=spec.request),
        ],
        return_annotation=spec.response,
    )
    return endpoint


_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorBody, "description": error.__name__}
    for error, status in ERROR_STATUS.items()
}

API_OPERATIONS = [spec for spec in OPERATIONS if spec.kind in ("agent", "api")]

router = APIRouter(prefix="/api")
for _spec in API_OPERATIONS:
    summary, _, description = _spec.description.partition("\n\n")
    router.add_api_route(
        f"/{_spec.subject}/{_spec.verb}",
        _endpoint(_spec),
        methods=["POST"],
        response_model=_spec.response,
        operation_id=_spec.name,
        summary=summary,
        description=description.strip(),
        tags=[_spec.subject],
        responses=_ERROR_RESPONSES,
    )


def openapi_document() -> dict[str, Any]:
    """The OpenAPI document of the API routes, with their bearer token requirement."""
    document = get_openapi(
        title="agentorg",
        version=__version__,
        summary="The record of agent sessions, tasks, asks, items and reports.",
        routes=router.routes,
    )
    document["components"]["securitySchemes"] = {"bearer": {"type": "http", "scheme": "bearer"}}
    document["security"] = [{"bearer": []}]
    return document

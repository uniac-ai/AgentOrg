"""The decisions page, mounted at `/`: every open ask, answerable, then the open workstreams.

Sign-in starts at `/ui/login?token=...`, whose one-time token comes from the `ui_login_link`
operation. Redeeming it starts a page session, kept in an HttpOnly, SameSite=Strict cookie, and
every answer form carries that page session's CSRF token. The routes call the service layer with
`Caller(channel="page")`; answering, `ask_answer`, is served by no other surface.
"""

import secrets
from typing import Annotated
from urllib.parse import parse_qs, quote

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import ValidationError

from agentorg.api import get_operations
from agentorg.models import Ask, AskAnswer, AskGet, AskList, ItemList, PageSession
from agentorg.operations import Caller, Conflict, Invalid, NotFound, Operations
from agentorg.page import views
from agentorg.page.model import Page, Refusal, group

COOKIE = "agentorg_page"
CALLER = Caller(channel="page")

OperationsDep = Annotated[Operations, Depends(get_operations)]

router = APIRouter(include_in_schema=False)


def _html(body: str, status_code: int = 200) -> HTMLResponse:
    return HTMLResponse(body, status_code, headers=views.HEADERS)


def _signed_out(text: str | None = None) -> HTMLResponse:
    return _html(views.message("Signed out", text, signed_out=True), 401)


async def _page_session(request: Request, operations: Operations) -> PageSession | None:
    session_id = request.cookies.get(COOKIE)
    return await operations.get_page_session(session_id) if session_id else None


async def _page(
    operations: Operations,
    page_session: PageSession,
    *,
    settled: Ask | None = None,
    refusal: Refusal | None = None,
) -> Page:
    asks = await operations.ask_list(AskList(state="open"), CALLER)
    items = await operations.item_list(ItemList(), CALLER)
    return Page(
        asks=group(asks.asks, asks.tasks, key=lambda ask: ask.opened_at),
        items=group(items.items, items.tasks, key=lambda item: item.updated_at),
        sessions={session.id: session for session in [*asks.sessions, *items.sessions]},
        csrf_token=page_session.csrf_token,
        settled=settled,
        refusal=refusal,
    )


async def _settled(operations: Operations, ask_id: str) -> Ask | None:
    """The ask just answered, as the record now holds it, or None if it is still open."""
    try:
        ask = await operations.ask_get(AskGet(ask=ask_id), CALLER)
    except (ValidationError, NotFound):
        return None
    return None if ask.state == "open" else ask


@router.get("/")
async def decisions(
    request: Request, operations: OperationsDep, answered: str | None = None
) -> HTMLResponse:
    page_session = await _page_session(request, operations)
    if page_session is None:
        return _signed_out()
    settled = await _settled(operations, answered) if answered else None
    return _html(views.decisions(await _page(operations, page_session, settled=settled)))


@router.get("/ui/login")
async def login(operations: OperationsDep, token: str = "") -> Response:
    try:
        page_session = await operations.redeem_login_token(token)
    except Invalid:
        return _signed_out("This sign-in link is used or expired.")
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(
        COOKIE,
        page_session.id,
        expires=page_session.expires_at,
        path="/",
        httponly=True,
        samesite="strict",
    )
    return response


@router.post("/ui/asks/{ask_id}/answer")
async def answer(ask_id: str, request: Request, operations: OperationsDep) -> Response:
    page_session = await _page_session(request, operations)
    if page_session is None:
        return _signed_out("The answer was not sent.")
    form = parse_qs((await request.body()).decode(errors="replace"))

    def field(name: str) -> str:
        return form.get(name, [""])[0]

    if not secrets.compare_digest(field("csrf").encode(), page_session.csrf_token.encode()):
        return _html(views.message("Not sent", "This page was out of date."), 403)
    choice = field("choice") or None
    words = field("words").strip() or None
    try:
        if choice is None and words is None:
            raise Invalid("Choose an option or write a note.")
        await operations.ask_answer(AskAnswer(ask=ask_id, choice=choice, words=words), CALLER)
    except Conflict:
        pass  # Answered or withdrawn meanwhile; the page then shows what the record holds.
    except NotFound:
        return _html(views.message("Not sent", "There is no such ask."), 404)
    except (Invalid, ValidationError) as error:
        reason = error.errors()[0]["msg"] if isinstance(error, ValidationError) else str(error)
        refusal = Refusal(ask=ask_id, message=reason, choice=choice, words=words)
        return _html(views.decisions(await _page(operations, page_session, refusal=refusal)), 422)
    return RedirectResponse(f"/?answered={quote(ask_id, safe='')}", status_code=303)

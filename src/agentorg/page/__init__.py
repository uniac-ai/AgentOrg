"""The decisions page, mounted at `/`.

Routes reach the service layer with `Depends(agentorg.api.get_operations)` and call it with
`Caller(channel="page")`. Answering an ask, `ask_answer`, is a user operation: the page is the
only surface that serves it, to a signed-in page session with its CSRF token. Sign-in starts at
`/ui/login?token=...`, whose token comes from the `ui_login_link` operation and is used up by
`Operations.redeem_login_token`.
"""

from fastapi import APIRouter

router = APIRouter()

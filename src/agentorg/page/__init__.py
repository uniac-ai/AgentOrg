"""The decisions page, mounted at `/`.

Routes reach the service layer with `Depends(agentorg.api.get_operations)` and call it with
`Caller(channel="page")`. Sign-in starts at `/ui/login?token=...`, whose token comes from the
`ui_login_link` operation and is used up by `Operations.redeem_login_token`.
"""

from fastapi import APIRouter

router = APIRouter()

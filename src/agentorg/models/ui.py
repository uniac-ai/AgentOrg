"""Sign-in to the decisions page: a one-time link that becomes a page session cookie."""

from pydantic import Field

from agentorg.models.common import ContractModel, Ref, Timestamp


class LoginLinkCreate(ContractModel):
    pass


class LoginLink(ContractModel):
    path: Ref = Field(description="The page path that signs in: /ui/login?token=... It works once.")
    expires_at: Timestamp


class PageSession(ContractModel):
    id: str
    csrf_token: str
    expires_at: Timestamp

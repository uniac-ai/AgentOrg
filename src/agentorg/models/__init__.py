"""Pydantic records and requests: the contract every surface shares.

A record is what the service stores and returns. A request is the input of one operation, named
after it (`AskOpen` for `ask_open`); a request's `session` field names the session acting.
`results` holds the results that bring records of several subjects together.
"""

from agentorg.models.ask import (
    Answer,
    AnswerChannel,
    Ask,
    AskAnswer,
    AskGet,
    AskList,
    AskOpen,
    AskRecordAnswer,
    AskState,
    AskWait,
    AskWithdraw,
    Option,
)
from agentorg.models.audit import AuditEntry, AuditList, AuditListResult, Channel
from agentorg.models.common import ContractModel, ErrorBody, Link
from agentorg.models.evidence import Evidence, EvidenceAdd, EvidenceKind
from agentorg.models.item import Item, ItemList, ItemPut, ItemResolve, ItemState
from agentorg.models.report import Inbox, InboxRead, Report, ReportAck, ReportSend
from agentorg.models.results import (
    AskListResult,
    ItemListResult,
    SessionArchiveResult,
    SessionContextResult,
    SessionFacts,
)
from agentorg.models.session import Session, SessionArchive, SessionContext, SessionStart
from agentorg.models.task import Task, TaskClose, TaskOpen, TaskState
from agentorg.models.ui import LoginLink, LoginLinkCreate, PageSession

__all__ = [
    "Answer",
    "AnswerChannel",
    "Ask",
    "AskAnswer",
    "AskGet",
    "AskList",
    "AskListResult",
    "AskOpen",
    "AskRecordAnswer",
    "AskState",
    "AskWait",
    "AskWithdraw",
    "AuditEntry",
    "AuditList",
    "AuditListResult",
    "Channel",
    "ContractModel",
    "ErrorBody",
    "Evidence",
    "EvidenceAdd",
    "EvidenceKind",
    "Inbox",
    "InboxRead",
    "Item",
    "ItemList",
    "ItemListResult",
    "ItemPut",
    "ItemResolve",
    "ItemState",
    "Link",
    "LoginLink",
    "LoginLinkCreate",
    "Option",
    "PageSession",
    "Report",
    "ReportAck",
    "ReportSend",
    "Session",
    "SessionArchive",
    "SessionArchiveResult",
    "SessionContext",
    "SessionContextResult",
    "SessionFacts",
    "SessionStart",
    "Task",
    "TaskClose",
    "TaskOpen",
    "TaskState",
]

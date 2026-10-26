"""Pydantic records and requests: the contract every surface shares.

A record is what the service stores and returns. A request is the input of one operation, named
after it (`AskOpen` for `ask.open`); a request's `session` field names the session acting.
"""

from agentorg.models.ask import (
    Answer,
    AnswerChannel,
    Ask,
    AskAnswer,
    AskGet,
    AskList,
    AskListResult,
    AskOpen,
    AskRecordAnswer,
    AskState,
    AskWait,
    Option,
)
from agentorg.models.audit import AuditEntry, AuditList, AuditListResult, Channel
from agentorg.models.common import ContractModel, ErrorBody, Link
from agentorg.models.evidence import Evidence, EvidenceAdd, EvidenceKind
from agentorg.models.item import Item, ItemList, ItemListResult, ItemPut, ItemResolve, ItemState
from agentorg.models.report import Inbox, InboxRead, Report, ReportAck, ReportSend
from agentorg.models.session import (
    Resource,
    Role,
    Session,
    SessionArchive,
    SessionArchiveResult,
    SessionDeclareRole,
    SessionList,
    SessionListResult,
    SessionRegister,
    SessionStart,
    SessionStartResult,
)
from agentorg.models.task import Task, TaskClose, TaskList, TaskListResult, TaskOpen, TaskState
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
    "Resource",
    "Role",
    "Session",
    "SessionArchive",
    "SessionArchiveResult",
    "SessionDeclareRole",
    "SessionList",
    "SessionListResult",
    "SessionRegister",
    "SessionStart",
    "SessionStartResult",
    "Task",
    "TaskClose",
    "TaskList",
    "TaskListResult",
    "TaskOpen",
    "TaskState",
]

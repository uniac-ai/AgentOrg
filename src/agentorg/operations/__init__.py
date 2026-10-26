"""The service layer's interface: the operations, the caller, and the errors.

`OPERATIONS` lists every operation in order. The API, MCP and the CLI derive their routes, tools
and commands from it, each serving the operations whose `Kind` is meant for it, so an operation
added to `Operations` appears on every surface it belongs on.
"""

from agentorg.operations.errors import Conflict, Forbidden, Invalid, NotFound, OperationError
from agentorg.operations.interface import (
    OPERATIONS,
    Caller,
    Kind,
    Operations,
    OperationSpec,
    operation,
)

__all__ = [
    "OPERATIONS",
    "Caller",
    "Conflict",
    "Forbidden",
    "Invalid",
    "Kind",
    "NotFound",
    "OperationError",
    "OperationSpec",
    "Operations",
    "operation",
]

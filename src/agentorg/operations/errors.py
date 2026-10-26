"""Errors an operation raises. Each surface turns them into its own error shape."""


class OperationError(Exception):
    """An operation refused its request. `code` is stable; the message is for the reader."""

    code = "error"


class NotFound(OperationError):
    code = "not_found"


class Invalid(OperationError):
    """The request is well formed but breaks a rule of the record."""

    code = "invalid"


class Forbidden(OperationError):
    """The acting session may not do this, such as acknowledging another session's report."""

    code = "forbidden"


class Conflict(OperationError):
    """The record's state does not allow it, such as answering an ask already answered."""

    code = "conflict"

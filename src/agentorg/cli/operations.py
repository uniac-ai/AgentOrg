"""Commands generated from the contract: `agentorg {subject} {verb}` for each operation the API
serves, the agent and API operations.

Each top-level field of the operation's request becomes a flag (`client_session_id` becomes
`--client-session-id`); a list field takes the flag once per item, and an item that is an
object is given as JSON. A required field named after the subject, such as `ask` in
`agentorg ask wait`, is a positional argument. `--json` gives the whole request as JSON, with
any flags overriding its fields. The result is printed as JSON.
"""

import argparse
import json
import sys
from collections.abc import Callable
from typing import Any

import anyio
from pydantic import BaseModel, ValidationError

from agentorg.api import API_OPERATIONS
from agentorg.client import RemoteOperations
from agentorg.operations import Caller, OperationSpec, invalid

Handler = Callable[[argparse.Namespace], int]

CALLER = Caller(channel="api")


def _schema(root: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """The schema itself, following a `$ref` and dropping the `null` of an optional field."""
    if "$ref" in schema:
        return _schema(root, root["$defs"][schema["$ref"].split("/")[-1]])
    variants = [variant for variant in schema.get("anyOf", []) if variant.get("type") != "null"]
    if len(variants) == 1:
        return _schema(root, variants[0]) | {"description": schema.get("description")}
    return schema


def _add_field(parser: argparse.ArgumentParser, name: str, schema: dict[str, Any]) -> None:
    flag = "--" + name.replace("_", "-")
    help = schema.get("description")
    kind = schema.get("type")
    if kind == "boolean":
        parser.add_argument(flag, dest=name, action=argparse.BooleanOptionalAction, help=help)
    elif kind == "array":
        item_kind = schema.get("items", {}).get("type")
        parser.add_argument(
            flag,
            dest=name,
            action="append",
            type=str if item_kind == "string" else json.loads,
            help=(help or "") + ("" if item_kind == "string" else " (one JSON object each)"),
        )
    else:
        convert = {"integer": int, "number": float, "string": str}.get(kind, json.loads)
        parser.add_argument(flag, dest=name, type=convert, help=help)


def request(args: argparse.Namespace) -> BaseModel:
    """The command's request, from `--json` and the flags."""
    body = json.loads(args.json) if args.json else {}
    body.update(
        {name: getattr(args, name) for name in args.fields if getattr(args, name) is not None}
    )
    try:
        return args.spec.request.model_validate(body)
    except ValidationError as error:
        raise invalid(error.errors()) from None


async def call(spec: OperationSpec, request: BaseModel) -> BaseModel:
    operations = RemoteOperations()
    async with operations.http:
        return await getattr(operations, spec.name)(request, CALLER)


def run_operation(args: argparse.Namespace) -> int:
    print_json(anyio.run(call, args.spec, request(args)))
    return 0


def print_json(result: BaseModel) -> None:
    sys.stdout.write(result.model_dump_json(indent=2) + "\n")


def add_operation_commands(
    commands: argparse._SubParsersAction, handlers: dict[str, Handler]
) -> dict[str, argparse.ArgumentParser]:
    """Add every operation's command and return the subject parsers by subject.

    A command runs `run_operation` unless `handlers` names another for its operation, whose
    docstring then ends the command's help.
    """
    verbs: dict[str, argparse._SubParsersAction] = {}
    subjects: dict[str, argparse.ArgumentParser] = {}
    for spec in API_OPERATIONS:
        if spec.subject not in verbs:
            subjects[spec.subject] = commands.add_parser(
                spec.subject, help=f"{spec.subject} operations"
            )
            verbs[spec.subject] = subjects[spec.subject].add_subparsers(
                title="operations", metavar="OPERATION"
            )
        summary = spec.description.split("\n\n")[0]
        handler = handlers.get(spec.name, run_operation)
        parser = verbs[spec.subject].add_parser(
            spec.verb.replace("_", "-"),
            help=summary,
            description=spec.description,
            epilog=" ".join(handler.__doc__.split()) if handler is not run_operation else None,
        )
        schema = spec.request.model_json_schema()
        fields = list(schema.get("properties", {}))
        for name in fields:
            field = _schema(schema, schema["properties"][name])
            if name == spec.subject and name in schema.get("required", []):
                parser.add_argument(name, nargs="?", help=field.get("description"))
            else:
                _add_field(parser, name, field)
        parser.add_argument("--json", help="the whole request as a JSON object")
        parser.set_defaults(handler=handler, spec=spec, fields=fields)
    return subjects

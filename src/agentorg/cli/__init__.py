"""The `agentorg` command line, generated from the contract.

`agentorg {subject} {verb}` runs any agent or API operation through the API; `serve`, `mcp`,
`ui`, `ask wait` and `session context` do more than print one call's result. Every command prints
its result as JSON on stdout and its errors on stderr, and exits non-zero when the service is down
or refuses.
"""

import argparse
import sys

from agentorg import __version__
from agentorg.cli.commands import add_commands, ask_wait, open_page, session_context
from agentorg.cli.operations import add_operation_commands
from agentorg.operations import OperationError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agentorg", description="The record of agent sessions, asks and reports."
    )
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(title="commands", metavar="COMMAND")
    add_commands(commands)
    subjects = add_operation_commands(
        commands, handlers={"ask_wait": ask_wait, "session_context": session_context}
    )
    subjects["ui"].set_defaults(handler=open_page)
    subjects["ui"].description = "With no operation, open the decisions page, signed in."
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not hasattr(args, "handler"):
        parser.print_help(sys.stderr)
        return 2
    try:
        return args.handler(args)
    except OperationError as error:
        print(f"agentorg: {error.code}: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f"agentorg: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130

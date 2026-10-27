/**
 * The `agentorg` command line, generated from the contract.
 *
 * `agentorg {subject} {verb}` runs any agent or API operation through the API; `serve`, `mcp`,
 * `ui`, `ask wait` and `session context` do more than print one call's result. Every command prints
 * its result as JSON on stdout and its errors on stderr, and exits non-zero when the service is
 * down or refuses, except `session context`, which stays silent for a client hook.
 */

import { remoteOperations } from "../client.ts";
import type { OperationName, RequestOf } from "../contract/index.ts";
import { type Caller, OperationError } from "../operations/index.ts";
import { VERSION } from "../version.ts";
import {
  ASK_WAIT_HELP,
  askWait,
  CALLER,
  MCP_HELP,
  mcpCommand,
  openPage,
  print,
  SERVE_HELP,
  SESSION_CONTEXT_HELP,
  serveCommand,
  sessionContext,
  UI_HELP,
} from "./commands.ts";
import { helpOf, operationOf, requestOf, usage } from "./operations.ts";

const HELP: Partial<Record<OperationName, string>> = {
  ask_wait: ASK_WAIT_HELP,
  session_context: SESSION_CONTEXT_HELP,
};

type Untyped = (request: unknown, caller: Caller) => Promise<unknown>;

async function run(argv: string[]): Promise<number> {
  const [command, verb, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return command === undefined ? 2 : 0;
  }
  if (command === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  // Help comes before anything a command does, so asking for it never acts.
  const help = argv.includes("--help") || argv.includes("-h");
  const show = (text: string) => {
    process.stdout.write(`${text}\n`);
    return 0;
  };
  if (command === "serve") return help ? show(SERVE_HELP) : serveCommand(argv.slice(1));
  if (command === "mcp") return help ? show(MCP_HELP) : mcpCommand(argv.slice(1));
  if (command === "ui" && (verb === undefined || verb.startsWith("-"))) {
    return help ? show(UI_HELP) : openPage();
  }
  const name = verb === undefined ? undefined : operationOf(command, verb);
  if (name === undefined) {
    process.stderr.write(`agentorg: unknown command ${argv.slice(0, 2).join(" ")}\n\n${usage()}\n`);
    return 2;
  }
  if (help) return show(helpOf(name, HELP[name]));
  const request = requestOf(name, rest);
  if (name === "ask_wait") return askWait(request as RequestOf<"ask_wait">);
  if (name === "session_context") return sessionContext(request as RequestOf<"session_context">);
  print(await (remoteOperations()[name] as Untyped)(request, CALLER));
  return 0;
}

/** Run a command line and return its exit status. */
export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (error) {
    if (error instanceof OperationError)
      process.stderr.write(`agentorg: ${error.code}: ${error.message}\n`);
    else process.stderr.write(`agentorg: ${(error as Error).message}\n`);
    return 1;
  }
}

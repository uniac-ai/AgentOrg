/** The actor-facing CLI: organization operations through the actor library. */

import { parseArgs } from "node:util";
import { help } from "../../runtime/command.ts";
import { builtinLines, builtinOf, helpOf, requestOf } from "./builtins.ts";
import { callCommand, interfacesCommand } from "./commands.ts";

const INTERFACES_HELP =
  "usage: agentorg interfaces\n\nList the selected actor's permitted Tools, with their interfaces, call aliases, descriptions and schemas.";
const CALL_HELP =
  "usage: agentorg call <name> [--json <input>]\n\nInvoke an explicit Hub interface using its call alias returned by interfaces. Input defaults to an empty object. Prints the Actor client's result or domain refusal.";

const usage = () =>
  [
    "usage: agentorg <operation> [flags]",
    "",
    "Call the organization's operations as an actor.",
    "",
    "  interfaces              List permitted Tools, interfaces and schemas.",
    "  call <name> --json <json> Invoke any permitted interface; print its complete answer.",
    ...builtinLines(),
    "",
    "Set AGENTORG_ACTOR_ID with AGENTORG_CREDENTIAL, else use the root's local identity.",
    "agentorg <operation> --help shows its flags.",
  ].join("\n");

export async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    help(usage());
    return command === undefined ? 2 : 0;
  }
  const builtin = builtinOf(argv);
  if (builtin !== undefined) {
    if (argv.includes("--help") || argv.includes("-h")) return help(helpOf(builtin.name));
    return callCommand(builtin.name, requestOf(builtin.name, builtin.rest), true);
  }
  if (command === "interfaces" || command === "call") {
    if (argv.includes("--help") || argv.includes("-h")) {
      return help(command === "interfaces" ? INTERFACES_HELP : CALL_HELP);
    }
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: command === "call" ? { json: { type: "string" } } : {},
      allowPositionals: true,
      strict: true,
    });
    if (command === "interfaces") {
      if (positionals.length) throw new Error(INTERFACES_HELP);
      return interfacesCommand();
    }
    if (positionals.length !== 1) throw new Error(CALL_HELP);
    let input: unknown;
    try {
      input = JSON.parse(String(values.json ?? "{}"));
    } catch {
      throw new Error("call input must be a JSON object");
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("call input must be a JSON object");
    }
    return callCommand(positionals[0] as string, input as Record<string, unknown>);
  }
  process.stderr.write(`agentorg: unknown operation ${argv.slice(0, 2).join(" ")}\n\n${usage()}\n`);
  return 2;
}

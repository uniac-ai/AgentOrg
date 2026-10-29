/** The actor-facing CLI: organization operations through the actor library. */

import { help } from "../../runtime/command.ts";
import { builtinLines, builtinOf, helpOf, requestOf } from "./builtins.ts";
import { builtinCommand } from "./commands.ts";

const usage = () =>
  [
    "usage: agentorg <operation> [flags]",
    "",
    "Call the organization's operations as an actor.",
    "",
    ...builtinLines(),
    "",
    "The actor's credential is AGENTORG_CREDENTIAL, else the root's local credential.",
    "agentorg <operation> --help shows its flags.",
  ].join("\n");

export async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    help(usage());
    return command === undefined ? 2 : 0;
  }
  const builtin = builtinOf(argv);
  if (builtin === undefined) {
    process.stderr.write(
      `agentorg: unknown operation ${argv.slice(0, 2).join(" ")}\n\n${usage()}\n`,
    );
    return 2;
  }
  if (argv.includes("--help") || argv.includes("-h")) return help(helpOf(builtin.name));
  return builtinCommand(builtin.name, requestOf(builtin.name, builtin.rest));
}

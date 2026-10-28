/**
 * The `agentorg` command line. `agentorg core` runs the core, and a command for each of the core's
 * built-in tools, such as `agentorg actor create`, runs it over `/mcp`. Every command prints its
 * result as JSON on stdout and its errors on stderr, and exits non-zero when it fails or the core
 * refuses.
 */

import { VERSION } from "../version.ts";
import { builtinLines, builtinOf, helpOf, requestOf } from "./builtins.ts";
import { builtinCommand, CORE_HELP, coreCommand } from "./commands.ts";

const usage = () =>
  [
    "usage: agentorg <command> [flags]",
    "",
    "An organization of AI agents, run like a company.",
    "",
    "  core [--port <n>]       run the core on 127.0.0.1",
    ...builtinLines(),
    "",
    "A built-in runs as the actor whose credential is in AGENTORG_CREDENTIAL, else as the root.",
    "`agentorg <command> --help` shows a command's flags.",
  ].join("\n");

async function run(argv: string[]): Promise<number> {
  const [command] = argv;
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
  if (command === "core") return help ? show(CORE_HELP) : coreCommand(argv.slice(1));
  const builtin = builtinOf(argv);
  if (builtin === undefined) {
    process.stderr.write(`agentorg: unknown command ${argv.slice(0, 2).join(" ")}\n\n${usage()}\n`);
    return 2;
  }
  if (help) return show(helpOf(builtin.name));
  return builtinCommand(builtin.name, requestOf(builtin.name, builtin.rest));
}

/** Run a command line and return its exit status. */
export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    process.stderr.write(`agentorg: ${code ? `${code}: ` : ""}${message}\n`);
    return 1;
  }
}

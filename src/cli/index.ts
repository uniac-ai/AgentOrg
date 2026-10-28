/**
 * The `agentorg` command line. `agentorg core` runs the core, `agentorg human` runs the human
 * actor, and `agentorg ui` signs a browser in to it. Every command prints its errors on stderr and
 * exits non-zero when it fails.
 */

import { HUMAN_HELP, humanCommand, UI_HELP, uiCommand } from "../human/command.ts";
import { VERSION } from "../version.ts";
import { CORE_HELP, coreCommand } from "./commands.ts";

const USAGE = `usage: agentorg <command> [flags]

An organization of AI agents, run like a company.

  core [--port <n>]       run the core on 127.0.0.1
  human [--port <n>]      run the human actor, the user's side
  ui                      open the web app, signed in

\`agentorg <command> --help\` shows a command's flags.`;

/** Each command's help and what runs it. */
const COMMANDS: Record<string, [string, (args: string[]) => Promise<number>]> = {
  core: [CORE_HELP, coreCommand],
  human: [HUMAN_HELP, humanCommand],
  ui: [UI_HELP, uiCommand],
};

async function run(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? 2 : 0;
  }
  if (command === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  // Help comes before anything a command does, so asking for it never acts.
  const help = argv.includes("--help") || argv.includes("-h");
  const found = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (found) {
    const [usage, execute] = found;
    if (!help) return execute(argv.slice(1));
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  process.stderr.write(`agentorg: unknown command ${command}\n\n${USAGE}\n`);
  return 2;
}

/** Run a command line and return its exit status. */
export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (error) {
    process.stderr.write(`agentorg: ${(error as Error).message}\n`);
    return 1;
  }
}

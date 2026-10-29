/**
 * The `agentorg` command line. `agentorg core` runs the core, `agentorg human` runs the human
 * actor, `agentorg ui` signs a browser in to it, and `agentorg agent` runs the agent actor for a
 * client's session. `agentorg service`, `connect`, `disconnect` and `status` set them up (see
 * `src/setup/`). A command for each of the core's built-in
 * tools, such as `agentorg actor create`, runs it over `/mcp`. Every command prints its errors on
 * stderr and exits non-zero when it fails or the core refuses.
 */

import { AGENT_HELP, agentCommand } from "../agent/command.ts";
import { HUMAN_HELP, humanCommand, UI_HELP, uiCommand } from "../human/command.ts";
import {
  CONNECT_HELP,
  connectCommand,
  disconnectCommand,
  SERVICE_HELP,
  STATUS_HELP,
  serviceCommand,
  statusCommand,
} from "../setup/command.ts";
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
    "  human [--port <n>]      run the human actor, which serves the web app",
    "  ui                      open the web app, signed in",
    "  agent [wait]            fill a position from an agent session, as its client starts it",
    "",
    "  service install         keep the core and the web app running as user services",
    "  service uninstall       stop and remove them",
    "  connect <client>        let a client's sessions in a project fill positions",
    "  disconnect <client>     remove what connect wrote",
    "  status                  show what is set up and whether it works",
    "",
    ...builtinLines(),
    "",
    "A built-in runs as the actor whose credential is in AGENTORG_CREDENTIAL, else as the root.",
    "`agentorg <command> --help` shows a command's flags.",
  ].join("\n");

/** Each command's help and what runs it. */
const COMMANDS: Record<string, [string, (args: string[]) => Promise<number>]> = {
  core: [CORE_HELP, coreCommand],
  human: [HUMAN_HELP, humanCommand],
  ui: [UI_HELP, uiCommand],
  agent: [AGENT_HELP, agentCommand],
  service: [SERVICE_HELP, serviceCommand],
  connect: [CONNECT_HELP, connectCommand],
  disconnect: [CONNECT_HELP, disconnectCommand],
  status: [STATUS_HELP, statusCommand],
};

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
  const found = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (found) {
    const [text, execute] = found;
    return help ? show(text) : execute(argv.slice(1));
  }
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

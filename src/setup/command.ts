/**
 * The setup commands: `agentorg service install|uninstall`, which keeps the core and the web app
 * running; `agentorg connect` and `agentorg disconnect`, which let a client's sessions in a project
 * fill positions; and `agentorg status`, which shows what is set up and whether it works.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { humanUrl } from "../human/command.ts";
import { coreUrl } from "../network/index.ts";
import { VERSION } from "../version.ts";
import { CLIENTS, clientOf } from "./clients.ts";
import { launcherPath, readLauncher, writeLauncher } from "./launcher.ts";
import { installServices, manager, type Service, uninstallServices } from "./services.ts";
import { answers, status } from "./status.ts";

const print = (...lines: string[]) => process.stdout.write(`${lines.join("\n")}\n`);
const CLIENT_NAMES = Object.keys(CLIENTS).join("|");

export const SERVICE_HELP = `usage: agentorg service install
       agentorg service uninstall

install keeps the core and the web app running as user services: launchd user agents on macOS and systemd user units on Linux, started at login and restarted whenever they exit. It first writes the launcher, <home>/bin/agentorg, which runs this agentorg on this Node with the AGENTORG_HOME, AGENTORG_PORT, AGENTORG_HUMAN_PORT and AGENTORG_URL set now; the services and connected projects start AgentOrg through it. It waits until the core and the web app answer. Run it again after upgrading AgentOrg or Node: it writes the launcher again and restarts both.

The services are agentorg and agentorg-human for the default home, ~/.local/share/agentorg, and carry a hash of the home's path for any other. install and uninstall refuse to replace or stop a service of that name that runs anything but this home's launcher.

uninstall stops and removes both services. The home, with the organization's records, stays.`;

export const CONNECT_HELP = `usage: agentorg connect <${CLIENT_NAMES}> [--project <dir>]
       agentorg disconnect <${CLIENT_NAMES}> [--project <dir>]

connect lets the client's sessions in a project folder, by default the current one, fill positions. Its entries name the launcher, which it writes when there is none, and link the agentorg skill from this package:
  claude-code: the org server in .mcp.json, its approval and AgentOrg's hooks in .claude/settings.local.json, and .claude/skills/agentorg;
  codex: the [mcp_servers.org] table in .codex/config.toml, and .agents/skills/agentorg.
The files' other entries stay as they are. The entries name paths on this machine, so they are not for committing. Sessions started afterwards fill positions; Codex reads .codex/config.toml once the user trusts the project. connect ends by running agentorg status through the launcher with only /usr/bin and /bin on PATH, as a desktop app may start it, and exits with its status.

disconnect removes what connect wrote, and nothing else.`;

export const STATUS_HELP = `usage: agentorg status [--project <dir>]

Show what is set up and whether it works: this agentorg and its Node, the launcher, whether the core and the web app answer and run as services, and whether each client is connected in the project, by default the current folder. It exits 1 when it finds a fault, and says what fixes each.`;

function projectOf(path: string | undefined): string {
  const project = resolve(path ?? process.cwd());
  if (!statSync(project, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${project} is not a folder`);
  }
  return project;
}

/** Wait until the service answers, or fail naming its logs. */
async function ready(service: Service): Promise<void> {
  const url = service.command === "core" ? coreUrl() : humanUrl();
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(250)) {
    if (await answers(url)) {
      print(`${service.title}: answering at ${url}, as service ${service.name}`);
      return;
    }
  }
  throw new Error(
    `${service.title} did not answer at ${url} within 30 seconds; see ${manager().logs(service)}`,
  );
}

export async function serviceCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [action, ...rest] = positionals;
  if (rest.length > 0 || (action !== "install" && action !== "uninstall")) {
    throw new Error("usage: agentorg service install|uninstall");
  }
  const managing = manager();
  if (action === "uninstall") {
    const removed = uninstallServices(managing);
    print(
      ...(removed.length === 0
        ? ["no AgentOrg services to remove"]
        : removed.map((service) => `removed service ${service.name}, ${service.title}`)),
    );
    return 0;
  }
  await installServices(managing, ready);
  const node = readLauncher()?.node;
  print(
    `launcher: ${launcherPath()}, running agentorg ${VERSION} on Node ${process.versions.node} at ${node}`,
    "`agentorg connect <client> --project <dir>` connects a project; `agentorg ui` opens the web app.",
  );
  return 0;
}

function clientArgs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { project: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1) throw new Error(`name one client: ${CLIENT_NAMES}`);
  return {
    name: positionals[0],
    client: clientOf(positionals[0]),
    project: projectOf(values.project),
  };
}

export async function connectCommand(args: string[]): Promise<number> {
  const { name, client, project } = clientArgs(args);
  const launcher = existsSync(launcherPath()) ? launcherPath() : writeLauncher();
  const written = client.connect(project, launcher);
  print(`connected ${name} in ${project}:`, ...written.map((path) => `  wrote ${path}`));
  print("checking through the launcher, with only /usr/bin and /bin on PATH:");
  const check = spawnSync(launcher, ["status", "--project", project], {
    env: { PATH: "/usr/bin:/bin", HOME: homedir() },
    encoding: "utf8",
  });
  process.stdout.write(`${check.stdout ?? ""}${check.stderr ?? ""}`);
  if (check.error) throw new Error(`the launcher ${launcher} did not run: ${check.error.message}`);
  return check.status ?? 1;
}

export async function disconnectCommand(args: string[]): Promise<number> {
  const { name, client, project } = clientArgs(args);
  const changed = client.disconnect(project);
  print(
    ...(changed.length === 0
      ? [`${name} was not connected in ${project}`]
      : [`disconnected ${name} in ${project}:`, ...changed.map((path) => `  changed ${path}`)]),
  );
  return 0;
}

export async function statusCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { project: { type: "string" } }, strict: true });
  const report = await status(projectOf(values.project));
  print(...report.lines);
  return report.fault ? 1 : 0;
}

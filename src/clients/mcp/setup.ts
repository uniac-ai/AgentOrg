/** Project integration and read-back for the MCP adapter. */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Level } from "../../domain/model/index.ts";
import { coreUrl } from "../../network/index.ts";
import { launcherPath, writeLauncher } from "../../runtime/launcher.ts";
import { answers, launcherStatus, printReport } from "../../runtime/status.ts";
import { CLIENTS, clientOf } from "./projects.ts";

const PROGRAM = "agentorg-mcp";
const NAMES = Object.keys(CLIENTS).join("|");
export const CONNECT_HELP = `usage: agentorg-mcp connect <${NAMES}> [--project <dir>] [--level ${Level.options.join("|")}]
       agentorg-mcp disconnect <${NAMES}> [--project <dir>]

connect pins this MCP adapter and Node in <home>/bin/agentorg-mcp, configures the project's org MCP server and hooks, and links the package's agentorg skill. --level chooses the interfaces the server presents; without it, the whole catalog. Claude Code also gets its MCP approval. The project's other entries stay as they are. Codex requires project trust, enabled hooks (features.hooks), and review and trust of the hook definitions through /hooks.

connect checks through the launcher with a bare PATH. disconnect removes only this adapter's entries.`;
export const STATUS_HELP = `usage: agentorg-mcp status [--project <dir>]

Report this adapter, its Node and launcher, core availability, and each client's project connection. Exit 1 on a fault.`;

const projectOf = (path: string | undefined) => {
  const project = resolve(path ?? process.cwd());
  if (!statSync(project, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${project} is not a folder`);
  return project;
};

export async function setupCommand(command: string, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { project: { type: "string" }, level: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const project = projectOf(values.project);
  if (command === "status") {
    if (positionals.length) throw new Error(STATUS_HELP);
    const report = launcherStatus(PROGRAM, "run agentorg-mcp connect <client> again");
    const up = await answers(coreUrl());
    report.lines.push(`the core: ${up ? "answering" : "not answering"} at ${coreUrl()}`);
    report.fault ||= !up;
    report.lines.push(`project ${project}:`);
    for (const [name, client] of Object.entries(CLIENTS)) {
      const problems = client.problems(project, launcherPath(PROGRAM));
      report.lines.push(
        `  ${name}: ${problems === undefined ? "not connected" : problems.length ? "connected, but:" : "connected"}`,
      );
      if (problems?.length) {
        report.fault = true;
        report.lines.push(
          ...problems.map((problem) => `    ${problem}`),
          `    run agentorg-mcp connect ${name} --project ${project} again`,
        );
      }
    }
    return printReport(report);
  }
  if (positionals.length !== 1) throw new Error(`name one client: ${NAMES}`);
  const name = positionals[0];
  const client = clientOf(name);
  if (command === "disconnect") {
    const changed = client.disconnect(project);
    process.stdout.write(
      changed.length
        ? `disconnected ${name} in ${project}:\n${changed.map((path) => `  removed ${path}`).join("\n")}\n`
        : `${name} was not connected\n`,
    );
    return 0;
  }
  const level = values.level === undefined ? undefined : Level.safeParse(values.level);
  if (level?.success === false)
    throw new Error(`unknown level ${values.level}; known: ${Level.options.join(", ")}`);
  const launcher = writeLauncher(PROGRAM);
  const written = client.connect(project, launcher, level?.data);
  process.stdout.write(
    `connected ${name} in ${project}:\n${written.map((path) => `  wrote ${path}`).join("\n")}\nchecking through the launcher, with only /usr/bin and /bin on PATH:\n`,
  );
  if (name === "codex") {
    process.stdout.write(
      "Codex: trust this project's configuration, enable features.hooks, and review and trust AgentOrg's definitions through /hooks. These hooks do not wake an idle turn.\n",
    );
  }
  const check = spawnSync(launcher, ["status", "--project", project], {
    env: { PATH: "/usr/bin:/bin", HOME: homedir() },
    encoding: "utf8",
  });
  process.stdout.write(`${check.stdout ?? ""}${check.stderr ?? ""}`);
  if (check.error) throw new Error(`the launcher ${launcher} did not run: ${check.error.message}`);
  return check.status ?? 1;
}

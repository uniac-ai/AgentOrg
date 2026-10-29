/**
 * What is set up, and whether it works: this command and its Node, the launcher, the services,
 * whether the core and the web app answer, and each client's connection in a project. Each line
 * that reports a fault says what fixes it.
 */

import { existsSync } from "node:fs";
import { humanUrl } from "../human/command.ts";
import { coreUrl } from "../network/index.ts";
import { VERSION } from "../version.ts";
import { CLIENTS } from "./clients.ts";
import {
  launcherCurrent,
  launcherPath,
  MINIMUM_NODE_TEXT,
  nodeSupported,
  PACKAGE,
  readLauncher,
} from "./launcher.ts";
import { type Manager, manager, type Service, services } from "./services.ts";

/** Whether something answers HTTP at the address. */
export async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

const REPIN = "run `agentorg service install`";

function serviceLine(managing: Manager | undefined, service: Service, launcher: string) {
  if (managing === undefined) return { text: "no service on this system", fault: false };
  const loaded = managing.loaded(service.name);
  if (loaded === undefined) {
    return existsSync(managing.file(service.name))
      ? { text: `service ${service.name} is installed but not loaded; ${REPIN}`, fault: true }
      : { text: `no service; ${REPIN} to keep it running`, fault: false };
  }
  if (loaded.program !== launcher) {
    return {
      text: `service ${service.name} runs ${loaded.program}, not the launcher`,
      fault: true,
    };
  }
  return loaded.running
    ? { text: `service ${service.name}, logs in ${managing.logs(service)}`, fault: false }
    : {
        text: `service ${service.name} is not running; see ${managing.logs(service)}`,
        fault: true,
      };
}

/** The report's lines, and whether it found a fault. */
export async function status(project: string): Promise<{ lines: string[]; fault: boolean }> {
  const lines: string[] = [];
  let fault = false;
  const say = (text: string, isFault = false) => {
    lines.push(text);
    fault ||= isFault;
  };

  const node = process.versions.node;
  say(`agentorg ${VERSION} at ${PACKAGE}, on Node ${node} at ${process.execPath}`);
  if (!nodeSupported(node)) say(`  Node ${node} is older than ${MINIMUM_NODE_TEXT}`, true);

  const path = launcherPath();
  const pinned = readLauncher(path);
  if (pinned === undefined) say(`launcher: none at ${path}; ${REPIN}`, true);
  else if (!launcherCurrent(pinned)) {
    const runs = `agentorg ${pinned.version ?? "(gone)"} at ${pinned.package} on ${pinned.node}`;
    say(`launcher: ${path} runs ${runs}, not this one; ${REPIN}`, true);
  } else say(`launcher: ${path}, on Node at ${pinned.node}`);

  let managing: Manager | undefined;
  try {
    managing = manager();
  } catch {}
  const [core, human] = services();
  for (const [service, url] of [
    [core, coreUrl()],
    [human, humanUrl()],
  ] as [Service, string][]) {
    const up = await answers(url);
    const line = serviceLine(managing, service, path);
    const answer = up ? `answering at ${url}` : `not answering at ${url}`;
    say(`${service.title}: ${answer}; ${line.text}`, !up || line.fault);
  }

  say(`project ${project}:`);
  for (const [name, client] of Object.entries(CLIENTS)) {
    const problems = client.problems(project, path);
    if (problems === undefined) say(`  ${name}: not connected`);
    else if (problems.length === 0) say(`  ${name}: connected`);
    else {
      say(`  ${name}: connected, but:`, true);
      for (const problem of problems) say(`    ${problem}`);
      say(`    run \`agentorg connect ${name}\` in the project again`);
    }
  }
  return { lines, fault };
}

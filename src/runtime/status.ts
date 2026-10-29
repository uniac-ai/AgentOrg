/** Read-back of executable launchers and one application's service. */

import { existsSync } from "node:fs";
import { VERSION } from "../version.ts";
import {
  launcherCurrent,
  launcherPath,
  MINIMUM_NODE_TEXT,
  nodeSupported,
  PACKAGE,
  readLauncher,
} from "./launcher.ts";
import { type Manager, manager, type Service } from "./services.ts";

export interface Report {
  lines: string[];
  fault: boolean;
}

export const printReport = (report: Report): number => {
  process.stdout.write(`${report.lines.join("\n")}\n`);
  return report.fault ? 1 : 0;
};

export async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

export function launcherStatus(program: string, repair: string): Report {
  const lines = [
    program +
      " " +
      VERSION +
      " at " +
      PACKAGE +
      ", on Node " +
      process.versions.node +
      " at " +
      process.execPath,
  ];
  let fault = false;
  if (!nodeSupported(process.versions.node)) {
    lines.push(`  Node ${process.versions.node} is older than ${MINIMUM_NODE_TEXT}`);
    fault = true;
  }
  const path = launcherPath(program);
  const pinned = readLauncher(program);
  if (pinned === undefined || !launcherCurrent(program, pinned)) {
    lines.push(`launcher: ${path} is not pinned to this executable; ${repair}`);
    fault = true;
  } else lines.push(`launcher: ${path}, on Node at ${pinned.node}`);
  return { lines, fault };
}

export async function serviceStatus(service: Service, url: string): Promise<Report> {
  const repair = `run ${service.program} service install`;
  const report = launcherStatus(service.program, repair);
  let managing: Manager | undefined;
  try {
    managing = manager();
  } catch {}
  const loaded = managing?.loaded(service.name);
  const up = await answers(url);
  let state: string;
  if (managing === undefined) state = "no service on this system";
  else if (loaded === undefined) {
    const installed = existsSync(managing.file(service.name));
    state = installed
      ? `service is installed but not loaded; ${repair}`
      : `no service; ${repair} to keep it running`;
    report.fault ||= installed;
  } else if (loaded.program !== launcherPath(service.program)) {
    state = `service ${service.name} runs ${loaded.program}, not the launcher`;
    report.fault = true;
  } else {
    state =
      "service " +
      service.name +
      (loaded.running ? ", logs in " : " is not running; see ") +
      managing.logs(service);
    report.fault ||= !loaded.running;
  }
  report.lines.push(`${service.title}: ${up ? "answering" : "not answering"} at ${url}; ${state}`);
  report.fault ||= !up;
  return report;
}

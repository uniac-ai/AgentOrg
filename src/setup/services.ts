/**
 * The core and the human actor as user services, which the system keeps running and starts at
 * login: launchd user agents on macOS, systemd user units on Linux. Each runs the launcher. The
 * default home's services are `agentorg` and `agentorg-human`; another home's names carry a hash of
 * its path, so two homes never share a service, and a scratch home never touches the default one's.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { home } from "../home.ts";
import { launcherPath, writeLauncher } from "./launcher.ts";

export interface Service {
  name: string;
  command: "core" | "human";
  /** What it is, for people. */
  title: string;
}

/** The default home's services keep the plain names; any other home's carry its hash. */
export function services(): Service[] {
  const ownHome = join(userInfo().homedir, ".local", "share", "agentorg");
  const base =
    resolve(home()) === resolve(ownHome)
      ? "agentorg"
      : `agentorg-${createHash("sha256").update(resolve(home())).digest("hex").slice(0, 8)}`;
  return [
    { name: base, command: "core", title: "the core" },
    { name: `${base}-human`, command: "human", title: "the web app" },
  ];
}

export interface Loaded {
  running: boolean;
  /** The program it runs. */
  program: string | undefined;
}

export interface Manager {
  /** The service's file. */
  file(name: string): string;
  text(service: Service, launcher: string): string;
  /** Load the file, replacing whatever is loaded under its name, and start it. */
  load(name: string, file: string): Promise<void>;
  /** Stop and unload what runs under the name, and remove its file. */
  unload(name: string, file: string): void;
  /** What is loaded under the name, if anything. */
  loaded(name: string): Loaded | undefined;
  /** Where the service's output goes. */
  logs(service: Service): string;
}

/** Run a command and return its status and output, never throwing on a non-zero exit. */
function run(command: string, args: string[]): { status: number; output: string } {
  try {
    return { status: 0, output: execFileSync(command, args, { encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    const { status, stdout, stderr, code } = error as {
      status: number | null;
      stdout?: string;
      stderr?: string;
      code?: string;
    };
    if (code === "ENOENT") throw new Error(`${command} is not on PATH`);
    return { status: status ?? 1, output: `${stdout ?? ""}${stderr ?? ""}` };
  }
}

function check(command: string, args: string[]): string {
  const { status, output } = run(command, args);
  if (status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${output.trim()}`);
  return output;
}

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const domain = () => `gui/${process.getuid?.()}`;
const logFile = (service: Service) => join(home(), "logs", `${service.command}.log`);

const launchd: Manager = {
  file: (name) => join(homedir(), "Library", "LaunchAgents", `${name}.plist`),
  text(service, launcher) {
    const log = escapeXml(logFile(service));
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- AgentOrg's ${service.title}, written by \`agentorg service install\`. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${escapeXml(service.name)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXml(launcher)}</string>
		<string>${service.command}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${log}</string>
	<key>StandardErrorPath</key>
	<string>${log}</string>
</dict>
</plist>
`;
  },
  async load(name, file) {
    run("launchctl", ["bootout", `${domain()}/${name}`]);
    // launchd may still be removing the job it just booted out, and refuses until it has.
    for (let attempt = 1; ; attempt++) {
      const { status, output } = run("launchctl", ["bootstrap", domain(), file]);
      if (status === 0) return;
      if (attempt === 10) throw new Error(`launchctl bootstrap ${file} failed: ${output.trim()}`);
      await sleep(500);
    }
  },
  unload(name, file) {
    run("launchctl", ["bootout", `${domain()}/${name}`]);
    rmSync(file, { force: true });
  },
  loaded(name) {
    const { status, output } = run("launchctl", ["print", `${domain()}/${name}`]);
    if (status !== 0) return undefined;
    const field = (key: string) => new RegExp(`^\\t${key} = (.*)$`, "m").exec(output)?.[1];
    return { running: field("state") === "running", program: field("program") };
  },
  logs: (service) => logFile(service),
};

/** A word for systemd's ExecStart, quoted, with its specifiers and variables escaped. */
const systemdWord = (text: string) =>
  `"${text.replace(/[\\"]/g, "\\$&").replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;

const unit = (name: string) => `${name}.service`;

const systemd: Manager = {
  file: (name) =>
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", unit(name)),
  text: (
    service,
    launcher,
  ) => `# AgentOrg's ${service.title}, written by \`agentorg service install\`.
[Unit]
Description=AgentOrg's ${service.title}

[Service]
ExecStart=${systemdWord(launcher)} ${service.command}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
  async load(name) {
    check("systemctl", ["--user", "daemon-reload"]);
    check("systemctl", ["--user", "enable", unit(name)]);
    check("systemctl", ["--user", "restart", unit(name)]);
  },
  unload(name, file) {
    run("systemctl", ["--user", "disable", "--now", unit(name)]);
    rmSync(file, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
  },
  loaded(name) {
    const { status, output } = run("systemctl", [
      "--user",
      "show",
      unit(name),
      "--property=LoadState,ActiveState,ExecStart",
    ]);
    const field = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(output)?.[1];
    if (status !== 0 || field("LoadState") !== "loaded") return undefined;
    return {
      running: field("ActiveState") === "active",
      program: /path=(\S+)/.exec(field("ExecStart") ?? "")?.[1],
    };
  },
  logs: (service) => `journalctl --user -u ${service.name}`,
};

const MANAGERS: Record<string, Manager> = { darwin: launchd, linux: systemd };

/** This system's service manager, or an error naming the systems AgentOrg's services run on. */
export function manager(): Manager {
  const found = Object.hasOwn(MANAGERS, process.platform) ? MANAGERS[process.platform] : undefined;
  if (found === undefined) {
    throw new Error(`services run on macOS (launchd) and Linux (systemd), not ${process.platform}`);
  }
  return found;
}

/**
 * Refuse to replace or stop a service of the same name that runs something other than this home's
 * launcher, such as one installed by hand or for another home.
 */
function guard(managing: Manager, service: Service, launcher: string): void {
  const loaded = managing.loaded(service.name);
  if (loaded === undefined || loaded.program === launcher) return;
  throw new Error(
    `a service named ${service.name} runs ${loaded.program ?? "something else"}, not ${launcher}; stop and remove it first`,
  );
}

/**
 * Write the launcher, then write, load and wait for each service, after checking that none would
 * replace a service this home's launcher doesn't run.
 */
export async function installServices(
  managing: Manager,
  ready: (service: Service) => Promise<void>,
): Promise<Service[]> {
  const all = services();
  for (const service of all) guard(managing, service, launcherPath());
  const launcher = writeLauncher();
  mkdirSync(join(home(), "logs"), { recursive: true, mode: 0o700 });
  for (const service of all) {
    const file = managing.file(service.name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, managing.text(service, launcher));
    await managing.load(service.name, file);
    await ready(service);
  }
  return all;
}

/** Stop and remove each service this home's launcher runs; return the ones removed. */
export function uninstallServices(managing: Manager): Service[] {
  const all = services().reverse();
  for (const service of all) guard(managing, service, launcherPath());
  return all.filter((service) => {
    const file = managing.file(service.name);
    const present = existsSync(file) || managing.loaded(service.name) !== undefined;
    managing.unload(service.name, file);
    return present;
  });
}

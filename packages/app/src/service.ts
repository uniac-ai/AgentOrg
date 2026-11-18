// AgentOrg as a background service on macOS: a LaunchAgent of the person's own, which starts the
// app at each login and again whenever it ends, on one home. There is one per account. Only
// `launchctl` changes launchd, and it is reached through `ServiceSystem`, so a test gives a
// stand-in and never the real one.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The service's name to launchd, after the app's bundle identifier. */
export const LABEL = "ai.uniac.agentorg.core";
/** How long the app has to answer after it is started, and to end after it is stopped. */
const START_MS = 60_000;
const STOP_MS = 15_000;
const POLL_MS = 250;
/** How often launchd is asked to start the service before its refusal is the answer. */
const BOOTSTRAP_TRIES = 3;
const BOOTSTRAP_WAIT_MS = 1_000;

/** The app answering on a home. */
export interface RunningApp {
  url: string;
  pid: number;
  version?: string;
}

/** What the service commands need of the machine. */
export interface ServiceSystem {
  platform: NodeJS.Platform;
  uid: number;
  /** The account's home folder, where `Library/LaunchAgents` is. */
  userHome: string;
  /** `launchctl` with these arguments, and how it ended. */
  launchctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** The app on `home`, if its process lives and its address answers. */
  running(home: string): Promise<RunningApp | undefined>;
  /** Whether a process lives. */
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

/** What the service runs, and with what around it. */
export interface ServiceRun {
  /** The Node program. */
  program: string;
  /** The app's command, `cli.js`. */
  cli: string;
  home: string;
  /** The service's environment: its `PATH` at least. */
  env: Record<string, string>;
}

/** Why a service command didn't do what was asked, in words for the person. */
export class ServiceError extends Error {}

/** Where the service's file is, for an account. */
export const plistPath = (userHome: string) =>
  join(userHome, "Library", "LaunchAgents", `${LABEL}.plist`);
/** Where the service writes what the app says, in its home. */
export const logPath = (home: string) => join(home, "logs", "core.log");

const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The service's file: the app on `home`, with no browser opened, started at login and again
 * whenever it ends, in the environment given, with what it writes in the home's log.
 */
export function plistFor({ program, cli, home, env }: ServiceRun): string {
  const args = [program, cli, "--home", home, "--no-open"];
  const log = logPath(home);
  const vars = Object.entries(env)
    .map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** The home a service's file runs the app on, if it is one of ours. */
export function homeOf(plist: string): string | undefined {
  const at = /<string>--home<\/string>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  return at?.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

const target = (system: ServiceSystem) => `gui/${system.uid}/${LABEL}`;

function onMac(system: ServiceSystem) {
  if (system.platform !== "darwin")
    throw new ServiceError(
      "AgentOrg runs as a background service on macOS only for now. Here, run agentorg in a terminal.",
    );
}

/** The service's file and the home it names, if it is set up. */
function setUp(system: ServiceSystem): { text: string; home?: string } | undefined {
  const file = plistPath(system.userHome);
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  const home = homeOf(text);
  return home === undefined ? { text } : { text, home };
}

/** Whether launchd has the service loaded now. */
async function loaded(system: ServiceSystem) {
  return (await system.launchctl(["print", target(system)])).code === 0;
}

/** Wait, up to `ms`, for what `check` finds: it, or `undefined` once the time is up. */
async function until<T>(
  system: ServiceSystem,
  ms: number,
  check: () => Promise<T | undefined>,
): Promise<T | undefined> {
  for (let waited = 0; ; waited += POLL_MS) {
    const found = await check();
    if (found !== undefined) return found;
    if (waited >= ms) return undefined;
    await system.sleep(POLL_MS);
  }
}
/** `true` when it holds, for `until`. */
const holds = (yes: boolean) => (yes ? true : undefined);

/** What `launchctl` said, for the person. */
const said = (args: string[], { code, stderr }: { code: number; stderr: string }) =>
  `launchctl ${args[0]} said ${stderr.trim() || `exit ${code}`}`;

/** A `launchctl` that must work, or the person is told what it said. */
async function must(system: ServiceSystem, args: string[], what: string) {
  const result = await system.launchctl(args);
  if (result.code !== 0) throw new ServiceError(`${what} didn't work: ${said(args, result)}.`);
}

/**
 * Take the service out of launchd, and wait until launchd has let it go and the app it ran on
 * `home` has ended: its process gone, not only its address, so the home is free again.
 */
async function bootout(system: ServiceSystem, home: string | undefined) {
  const app = home === undefined ? undefined : await system.running(home);
  await must(system, ["bootout", target(system)], "Stopping the service");
  const gone = await until(system, STOP_MS, async () => holds(!(await loaded(system))));
  const ended =
    gone &&
    (app === undefined ||
      (await until(system, STOP_MS, async () => holds(!system.alive(app.pid)))));
  if (!ended)
    throw new ServiceError(
      `The service was told to stop, but ${gone ? `AgentOrg on ${home} hasn't ended` : "launchd still has it"} after ${STOP_MS / 1000} seconds.`,
    );
}

/**
 * Hand the service's file to launchd. Right after a bootout launchd can still refuse it for a
 * moment, so it is asked again before its refusal is the answer.
 */
async function bootstrap(system: ServiceSystem) {
  const args = ["bootstrap", `gui/${system.uid}`, plistPath(system.userHome)];
  let result = await system.launchctl(args);
  for (let tries = 1; result.code !== 0 && tries < BOOTSTRAP_TRIES; tries++) {
    await system.sleep(BOOTSTRAP_WAIT_MS);
    result = await system.launchctl(args);
  }
  if (result.code !== 0)
    throw new ServiceError(
      `Starting the service didn't work: ${said(args, result)}. If AgentOrg is switched off under System Settings, General, Login Items, switch it on and run agentorg start again.`,
    );
}

/**
 * `agentorg start`: run the app on `run.home` as the service, from now on at every login, and
 * wait for it to answer. Its file is written, or written again when what it runs changed; a
 * service already running as asked is left as it is. It answers the app's address, and says when
 * the service ran on another home before.
 */
export async function start(
  system: ServiceSystem,
  run: ServiceRun,
): Promise<{ url: string; note?: string }> {
  onMac(system);
  const file = plistPath(system.userHome);
  const text = plistFor(run);
  const before = setUp(system);
  let isLoaded = await loaded(system);
  const asService = isLoaded && before?.home === run.home;
  const app = await system.running(run.home);
  // The app on this home in a terminal: two would want the home, and launchd would start it again
  // every few seconds in vain.
  if (app && !asService)
    throw new ServiceError(
      `AgentOrg is already running on ${run.home} (process ${app.pid}), but not as the service. Stop it where it was started, then run agentorg start.`,
    );
  // launchd writes the log, but doesn't make its folder.
  mkdirSync(dirname(logPath(run.home)), { recursive: true, mode: 0o700 });
  if (before?.text !== text) {
    if (isLoaded) {
      await bootout(system, before?.home);
      isLoaded = false;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
    renameSync(`${file}.tmp`, file);
  }
  // Stopped with agentorg stop, it was disabled so a login wouldn't start it: it is wanted again.
  await must(system, ["enable", target(system)], "Letting the service start at login");
  if (!isLoaded) await bootstrap(system);
  else if (!app) await must(system, ["kickstart", target(system)], "Starting the service");
  const answered = await until(system, START_MS, () => system.running(run.home));
  if (!answered)
    throw new ServiceError(
      `The service started, but AgentOrg didn't answer within ${START_MS / 1000} seconds. What it said is in ${logPath(run.home)}.`,
    );
  const was = before?.home;
  return {
    url: answered.url,
    ...(was !== undefined && was !== run.home ? { note: `It ran on ${was} before.` } : {}),
  };
}

/**
 * `agentorg stop`: stop the service, whatever home it runs on, and keep it from starting at login
 * until `agentorg start`. It answers what there was to stop, and the home the service ran on.
 */
export async function stop(
  system: ServiceSystem,
  home: string,
): Promise<{ was: "running" | "set-up" | "none"; on?: string }> {
  onMac(system);
  const before = setUp(system);
  const isLoaded = await loaded(system);
  if (!before && !isLoaded) {
    if (await system.running(home))
      throw new ServiceError(
        `AgentOrg is running on ${home}, but not as the service. Stop it where it was started.`,
      );
    return { was: "none" };
  }
  // Disabled first, so nothing starts it again in between, and so a service that is set up but
  // isn't running doesn't start at the next login either.
  await must(system, ["disable", target(system)], "Keeping the service from starting at login");
  if (isLoaded) await bootout(system, before?.home);
  return { was: isLoaded ? "running" : "set-up", ...(before?.home ? { on: before.home } : {}) };
}

/** What `agentorg status` says, line by line, and whether the app answers on the home. */
export async function status(
  system: ServiceSystem,
  home: string,
): Promise<{ lines: string[]; running: boolean }> {
  const app = await system.running(home);
  const lines = [
    app
      ? `AgentOrg${app.version ? ` ${app.version}` : ""} is running at ${app.url}, on ${home}.`
      : `AgentOrg isn't running on ${home}.`,
  ];
  if (system.platform === "darwin") {
    const before = setUp(system);
    const elsewhere =
      before?.home !== undefined && before.home !== home ? `, for ${before.home}` : "";
    if (!before) lines.push("It isn't set up as a service. agentorg start sets it up.");
    else if (await loaded(system))
      lines.push(`The service is on${elsewhere}: it starts at login and again if it ends.`);
    else lines.push(`The service is stopped${elsewhere}. agentorg start starts it.`);
  }
  return { lines, running: app !== undefined };
}

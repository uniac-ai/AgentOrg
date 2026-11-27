#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hubHome, personCall, UsageError } from "@agentorg/sdk/person-commands";
import WebSocket from "ws";

const USAGE = `Usage: agentorg [command] [--home DIR]
       agentorg --version

  (no command) [--port N] [--no-open] [--frontend DIR]
                                            run AgentOrg: the Hub, your gateway and the frontend:
                                            the one it carries, or the folder DIR
  open                                      sign a browser in to the running app
  start [--no-open]                         run it as a background service on macOS: at every
                                            login, and again whenever it ends
  stop                                      stop the service, until agentorg start
  status                                    whether it runs, where, and as a service
  update                                    update AgentOrg and its Mac app, as the one line
                                            installed them on a Mac, on the channel it installed
  update --back [--yes]                     put back the release before the last update, with
                                            the home as it was then; what changed since is lost
  uninstall [--delete-home]                 remove the service and what the line installed,
                                            its Mac app too; the home stays unless --delete-home
  hub [--port N]                            run a bare Hub, without the shell
  actors | bindings | exports | audit       each one's list
  bind <consumer.slot> <provider.export>    hub.grants.bind
  call <slot> <method> [json]               call one of the person's slots

While the app runs, the person's commands go through it; otherwise they use the Hub home's
person-credential. The home is --home, else $AGENTORG_HUB_HOME, else
$XDG_DATA_HOME/agentorg, else ~/.local/share/agentorg.
`;

const write = (stream: NodeJS.WriteStream, text: string) => stream.write(`${text}\n`);
function usage(problem?: string): never {
  if (problem) write(process.stderr, problem);
  process.stderr.write(USAGE);
  process.exit(2);
}

// Loose: commands the SDK serves take their own options, and it reads them itself.
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    home: { type: "string" },
    port: { type: "string" },
    frontend: { type: "string" },
    "no-open": { type: "boolean" },
    "delete-home": { type: "boolean" },
    back: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean" },
  },
  allowPositionals: true,
  strict: false,
});
const [command, ...rest] = positionals as string[];
// `hub` is the SDK's, which reads its options itself, strictly. Everything else is
// this command's: an option it doesn't know is a mistake, never a reason to start the app.
if (command !== "hub") {
  const known = ["home", "port", "frontend", "no-open", "help", "version"];
  if (command === "uninstall") known.push("delete-home");
  if (command === "update") known.push("back", "yes");
  const unknown = Object.keys(values).find((name) => !known.includes(name));
  if (unknown !== undefined)
    usage(
      `Unknown option ${unknown.length === 1 ? "-" : "--"}${unknown}. An argument that starts with - goes after --.`,
    );
  // A value is a word of its own: an option in its place means the value is missing.
  for (const [name, what] of [
    ["home", "a directory"],
    ["port", "a port number"],
    ["frontend", "a directory"],
  ] as const) {
    const value = values[name];
    if (typeof value === "boolean" || value === "" || value?.startsWith("-"))
      usage(`--${name} takes ${what}.`);
  }
}
/** This core's version. */
const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
if (values.version && command === undefined) {
  write(process.stdout, VERSION);
  process.exit(0);
}
if (values.help && command === undefined) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const home = hubHome(values.home as string | undefined);

/** Whether a process lives. The app runs as this user, so one this user can't signal is gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The app as a home's `app.json` says, if its process lives. */
function recorded(at: string): { url: string; pid: number; version?: string } | undefined {
  try {
    const app = JSON.parse(readFileSync(join(at, "app.json"), "utf8")) as {
      url: string;
      pid: number;
      version?: string;
    };
    return alive(app.pid) ? app : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the app answers at its address. A record left by an app that crashed can name a process
 * that has since been given to something else, so a living pid isn't enough.
 */
async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/** The app on a home, if its process lives and its address answers. */
async function runningOn(at: string) {
  const app = recorded(at);
  return app && (await answers(app.url)) ? app : undefined;
}

/** The running app in this home, if there is one: its address, and the CLI's token. */
function running(): { url: string; token: string } | undefined {
  const app = recorded(home);
  if (!app) return undefined;
  try {
    return { url: app.url, token: readFileSync(join(home, "cli-token"), "utf8").trim() };
  } catch {
    return undefined;
  }
}

/** Open an address in the person's browser; whether something took it. */
function openBrowser(url: string): Promise<boolean> {
  const [program, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url]]
        : ["xdg-open", [url]];
  return new Promise((done) => {
    const child = spawn(program as string, args as string[], { stdio: "ignore", detached: true });
    child.once("error", () => done(false));
    child.once("spawn", () => {
      child.unref();
      done(true);
    });
  });
}

/** A fresh sign-in address from the running app, through the CLI's token. */
async function signInAddress(app: { url: string; token: string }): Promise<string> {
  const response = await fetch(`${app.url}/api/code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${app.token}` },
  });
  if (!response.ok)
    throw new Error(`AgentOrg at ${app.url} refused to sign a browser in (${response.status}).`);
  const { code } = (await response.json()) as { code: string };
  return `${app.url}/signin#${code}`;
}

/**
 * One call through the running app's gateway, as the person; its result printed as JSON.
 * `unreachable` when nothing answers there, so the caller can go another way.
 */
function throughApp(
  app: { url: string; token: string },
  call: { slot: string; method: string; input: unknown },
): Promise<"done" | "unreachable"> {
  return new Promise((done) => {
    let answered = false;
    const socket = new WebSocket(`${app.url.replace(/^http/, "ws")}/api`, {
      headers: { Authorization: `Bearer ${app.token}` },
    });
    socket.once("open", () => socket.send(JSON.stringify({ id: 1, op: "call", ...call })));
    socket.on("message", (data) => {
      const reply = JSON.parse(String(data)) as {
        id?: number;
        result?: unknown;
        error?: { name: string; message: string; code?: string };
      };
      if (reply.id !== 1) return;
      answered = true;
      socket.close();
      if (reply.error) {
        write(
          process.stderr,
          reply.error.name === "Refused"
            ? `Refused (${reply.error.code}): ${reply.error.message}`
            : `${reply.error.name}: ${reply.error.message}`,
        );
        process.exitCode = 1;
      } else write(process.stdout, JSON.stringify(reply.result, null, 2));
      done("done");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") return done("unreachable");
      write(process.stderr, `The app didn't answer: ${error.message}`);
      process.exitCode = 1;
      done("done");
    });
    socket.once("close", () => {
      if (answered) return;
      write(process.stderr, "The app closed the connection before answering; check its state.");
      process.exitCode = 1;
      done("done");
    });
  });
}

/** Sign a browser in to the running app; whether one opened. */
async function signBrowserIn(app: { url: string; token: string }): Promise<boolean> {
  return openBrowser(await signInAddress(app));
}

async function runApp() {
  const port = values.port as string | undefined;
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) > 65535))
    usage("--port takes a port number.");
  // Already running on this home, as the service or in another terminal: open it, don't fight it.
  // Asked for a port or a frontend, it says it can't give them.
  const already = running();
  if (already && (await answers(already.url))) {
    write(process.stdout, `AgentOrg is already running at ${already.url}, home ${home}.`);
    if (port !== undefined || values.frontend !== undefined) {
      write(process.stderr, "Stop it first to run it with --port or --frontend.");
      process.exit(1);
    }
    if (!values["no-open"] && !(await signBrowserIn(already)))
      write(process.stdout, "No browser opened here. Run agentorg open where you have one.");
    return;
  }
  // The Hub is loaded only to run the app: a command through it needs none of it.
  const { startApp } = await import("./app.js");
  let app: Awaited<ReturnType<typeof startApp>>;
  try {
    const frontend = values.frontend as string | undefined;
    app = await startApp({
      home,
      ...(port === undefined ? {} : { port: Number(port) }),
      ...(frontend === undefined ? {} : { frontend }),
      // A home with no agents gets the Assistant once AgentOrg Mac is there.
      firstRun: { assistant: true },
    });
  } catch (error) {
    // Another Hub already has the home, the port is taken, or the home is from a newer version.
    write(process.stderr, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  write(process.stdout, `AgentOrg at ${app.url}, home ${home}`);
  void app.closed.then(({ lost }) => {
    if (!lost) return;
    write(
      process.stderr,
      "The person's channel ended: another program took it, or the Hub stopped. AgentOrg stopped.",
    );
    process.exit(1);
  });
  // The sign-in code goes to the browser only, never to the terminal. With no frontend, there is
  // nothing to sign in to.
  if (!app.frontend)
    write(
      process.stdout,
      "No frontend: give one with --frontend DIR to use AgentOrg in a browser.",
    );
  else if (!values["no-open"] && !(await openBrowser(app.signInUrl())))
    write(process.stdout, "No browser opened here. Run agentorg open where you have one.");
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/**
 * The Node this runs on, as the PATH names it when it does: `process.execPath` is resolved, and a
 * package manager's versioned folder behind a link can be gone after its next upgrade.
 */
function nodeByName(): string {
  const own = realpathSync(process.execPath);
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    const named = join(folder, "node");
    try {
      if (folder && existsSync(named) && realpathSync(named) === own) return named;
    } catch {}
  }
  return process.execPath;
}

/** The person's yes to `question` in this terminal; no where there is no terminal to ask in. */
async function confirmed(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await terminal.question(question)).trim());
  } finally {
    terminal.close();
  }
}

/** The service commands' view of this machine: the real `launchctl`, on this account. */
async function serviceCommand(name: "start" | "stop" | "status" | "update" | "uninstall") {
  const service = await import("./service.js");
  const system: import("./service.js").ServiceSystem = {
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    userHome: homedir(),
    launchctl: (args) =>
      new Promise((done) =>
        execFile("launchctl", args, { timeout: 30_000 }, (error, stdout, stderr) =>
          done({
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
        ),
      ),
    // The Mac app's uninstall waits up to 45 s for its provider to end.
    command: (program, args) =>
      new Promise((done) =>
        execFile(program, args, { timeout: 120_000 }, (error, stdout, stderr) =>
          done({
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            stdout: String(stdout),
            stderr: error && !stderr ? error.message : String(stderr),
          }),
        ),
      ),
    running: runningOn,
    alive,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
  try {
    if (name === "update" || name === "uninstall") {
      const installed = await import("./installed.js");
      if (name === "uninstall")
        await installed.uninstall(system, home, {
          deleteHome: values["delete-home"] === true,
          say: (line) => write(process.stdout, line),
        });
      else if (process.platform !== "darwin") throw new service.ServiceError(installed.ELSEWHERE);
      else if (values.back) {
        const step = installed.backStep(homedir());
        if (!step) throw new service.ServiceError(installed.NO_STEP_BACK);
        write(process.stdout, installed.backWarning(step));
        if (!values.yes && !(await confirmed("Go back? [y/N] ")))
          throw new service.ServiceError(
            process.stdin.isTTY
              ? "Nothing was changed."
              : "Nothing was changed: run agentorg update --back --yes to go back without being asked.",
          );
        process.exitCode = await installed.back(installed.RELEASE, home, step);
      } else {
        const channel = installed.recordedChannel(homedir());
        write(process.stdout, `Checking for updates on AgentOrg's ${channel} channel...`);
        process.exitCode = await installed.update(installed.RELEASE, home, channel);
      }
    } else if (name === "status") {
      const { lines, running: answers } = await service.status(system, home);
      // Whether a newer release is out on the line's channel: asked at most once a day, here only.
      const [{ checkForUpdate, updateLine }, { RELEASE }] = await Promise.all([
        import("./updates.js"),
        import("./installed.js"),
      ]);
      await checkForUpdate(homedir(), RELEASE);
      const update = updateLine(homedir(), VERSION);
      for (const line of update ? [...lines, update] : lines) write(process.stdout, line);
      process.exitCode = answers ? 0 : 3;
    } else if (name === "stop") {
      const { was, on } = await service.stop(system, home);
      const other = on !== undefined && on !== home ? ` It ran on ${on}.` : "";
      write(
        process.stdout,
        was === "running"
          ? `Stopped. It won't start again, also at a login, until agentorg start.${other}`
          : was === "set-up"
            ? `The service wasn't running. It won't start at a login either, until agentorg start.${other}`
            : "AgentOrg isn't set up as a service.",
      );
    } else {
      const program = nodeByName();
      // Its PATH is this shell's, as it is now, with its Node first: what the app looks for by name
      // (agentcomputer, for one) is found under the service as it is here.
      const path = [dirname(program), ...(process.env.PATH ?? "").split(delimiter)]
        .filter((folder, at, all) => folder !== "" && all.indexOf(folder) === at)
        .join(delimiter);
      const data = process.env.AGENTCOMPUTER_DATA;
      const { url, note } = await service.start(system, {
        program,
        cli: fileURLToPath(import.meta.url),
        home,
        env: { PATH: path, ...(data ? { AGENTCOMPUTER_DATA: data } : {}) },
      });
      write(
        process.stdout,
        `AgentOrg is running at ${url}, home ${home}, as a service: it starts at every login, and again whenever it ends.${note ? ` ${note}` : ""}`,
      );
      const app = running();
      if (!values["no-open"] && app && !(await signBrowserIn(app)))
        write(process.stdout, "No browser opened here. Run agentorg open where you have one.");
    }
  } catch (error) {
    if (!(error instanceof service.ServiceError)) throw error;
    write(process.stderr, error.message);
    process.exit(1);
  }
}

if (command === undefined) await runApp();
else if (["start", "stop", "status", "update", "uninstall"].includes(command)) {
  if (rest.length > 0) usage(`agentorg ${command} takes no arguments.`);
  if (values.port !== undefined || values.frontend !== undefined)
    usage(`agentorg ${command} takes no --port or --frontend.`);
  if (values.yes && !values.back) usage("--yes goes with agentorg update --back.");
  await serviceCommand(command as "start" | "stop" | "status" | "update" | "uninstall");
} else if (command === "open") {
  const app = running();
  if (!app || !(await answers(app.url))) {
    write(
      process.stderr,
      `AgentOrg isn't running in ${home}. Run ${process.platform === "darwin" ? "agentorg start" : "agentorg"} first.`,
    );
    process.exit(1);
  }
  let opened: boolean;
  try {
    opened = await signBrowserIn(app);
  } catch (error) {
    write(process.stderr, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (!opened) {
    write(process.stderr, "No browser could be opened here.");
    process.exit(1);
  }
} else if (command === "hub") await import("@agentorg/sdk/cli");
else {
  let call: ReturnType<typeof personCall>;
  try {
    call = personCall(command, rest);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    usage(error.message);
  }
  if (!call) usage(`Unknown command ${JSON.stringify(command)}.`);
  const app = running();
  // With no app answering, the SDK's CLI acts as the person over its own channel.
  if (!app || (await throughApp(app, call)) === "unreachable") await import("@agentorg/sdk/cli");
}

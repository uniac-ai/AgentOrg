#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { hubHome, personCall, UsageError } from "@agentorg/sdk/person-commands";
import WebSocket from "ws";

const USAGE = `Usage: agentorg [command] [--home DIR]
       agentorg --version

  (no command) [--port N] [--no-open]       run AgentOrg: the Hub, your gateway and the shell
  open                                      sign a browser in to the running app
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
    "no-open": { type: "boolean" },
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
  const unknown = Object.keys(values).find(
    (name) => !["home", "port", "no-open", "help", "version"].includes(name),
  );
  if (unknown !== undefined)
    usage(
      `Unknown option ${unknown.length === 1 ? "-" : "--"}${unknown}. An argument that starts with - goes after --.`,
    );
  // A value is a word of its own: an option in its place means the value is missing.
  for (const [name, what] of [
    ["home", "a directory"],
    ["port", "a port number"],
  ] as const) {
    const value = values[name];
    if (typeof value === "boolean" || value?.startsWith("-")) usage(`--${name} takes ${what}.`);
  }
}
if (values.version && command === undefined) {
  const own = new URL("../../package.json", import.meta.url);
  write(process.stdout, (JSON.parse(readFileSync(own, "utf8")) as { version: string }).version);
  process.exit(0);
}
if (values.help && command === undefined) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const home = hubHome(values.home as string | undefined);

/** The running app in this home, if there is one: its address, and the CLI's token. */
function running(): { url: string; token: string } | undefined {
  try {
    const { url, pid } = JSON.parse(readFileSync(join(home, "app.json"), "utf8")) as {
      url: string;
      pid: number;
    };
    // The app runs as this user, so a pid this user can't signal is someone else's now.
    try {
      process.kill(pid, 0);
    } catch {
      return undefined;
    }
    return { url, token: readFileSync(join(home, "cli-token"), "utf8").trim() };
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
  if (!response.ok) throw new Error(`The app refused (${response.status}).`);
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

async function runApp() {
  const port = values.port as string | undefined;
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) > 65535))
    usage("--port takes a port number.");
  // The Hub is loaded only to run the app: a command through it needs none of it.
  const { startApp } = await import("./gateway.js");
  let app: Awaited<ReturnType<typeof startApp>>;
  try {
    app = await startApp({ home, ...(port === undefined ? {} : { port: Number(port) }) });
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
  // The sign-in code goes to the browser only, never to the terminal.
  if (!values["no-open"] && !(await openBrowser(app.signInUrl())))
    write(process.stdout, "No browser opened here. Run agentorg open where you have one.");
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (command === undefined) await runApp();
else if (command === "open") {
  const app = running();
  if (!app) {
    write(process.stderr, `AgentOrg isn't running in ${home}. Run agentorg first.`);
    process.exit(1);
  }
  if (!(await openBrowser(await signInAddress(app)))) {
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

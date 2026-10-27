/**
 * The commands that do more than print one call's result: serve, the stdio proxy, the page
 * sign-in, the long-polling ask wait, and the session context for client hooks.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { serve as listen } from "@hono/node-server";
import type { z } from "zod";
import { createApp } from "../app.ts";
import { DEFAULT_PORT, port, remoteOperations, serviceUrl, Unavailable } from "../client.ts";
import type { Ask } from "../contract/index.ts";
import { databasePath, ensureHome, ensureToken } from "../home.ts";
import { runProxy } from "../mcp/proxy.ts";
import type { Caller } from "../operations/index.ts";
import { StoreService } from "../operations/service.ts";

export const CALLER: Caller = { channel: "api" };

/** How long each request of `agentorg ask wait` waits before asking again. */
export const POLL_SECONDS = 30;

export const print = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const note = (text: string) => process.stderr.write(`agentorg: ${text}\n`);

/**
 * Load the store, which only the service needs, without the warning Node 22 prints the first time
 * `node:sqlite` loads, which would otherwise open every service log. Other warnings pass through.
 */
async function withoutSqliteWarning<T>(load: () => Promise<T>): Promise<T> {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const options = rest[0];
    const type = typeof options === "string" ? options : (options as { type?: string })?.type;
    const message = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && message.startsWith("SQLite")) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await load();
  } finally {
    process.emitWarning = emitWarning;
  }
}

export async function serveCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: "string" } }, strict: true });
  const listenPort = values.port === undefined ? port() : Number(values.port);
  ensureHome();
  const token = ensureToken();
  const { Store } = await withoutSqliteWarning(() => import("../store/index.ts"));
  const store = new Store(databasePath());
  const app = createApp(new StoreService(store), { token });
  const server = listen({ fetch: app.fetch, hostname: "127.0.0.1", port: listenPort });
  await Promise.race([
    once(server, "listening"),
    once(server, "error").then(([error]) => Promise.reject(error)),
  ]);
  note(`serving on http://127.0.0.1:${listenPort}`);
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  await new Promise((resolve) => server.close(resolve));
  store.close();
  return 0;
}

export async function mcpCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { client: { type: "string" }, "client-session-env": { type: "string" } },
    strict: true,
  });
  const variable = values["client-session-env"];
  const clientSessionId = (variable && process.env[variable]) || undefined;
  const operations = remoteOperations({ client: values.client, clientSessionId });
  await runProxy(operations, { channel: "mcp", client: values.client, clientSessionId });
  return 0;
}

export const SERVE_HELP = `usage: agentorg serve [--port <n>]

Run the service on 127.0.0.1, at --port, else AGENTORG_PORT, else ${DEFAULT_PORT}. On first start it creates the agentorg home (AGENTORG_HOME, default ~/.local/share/agentorg) and a token file readable only by you. It logs to stderr and stops on SIGINT or SIGTERM.`;

export const MCP_HELP = `usage: agentorg mcp --client <kind> [--client-session-env <variable>]

Serve MCP over stdin and stdout for clients that only spawn stdio servers, performing each call over the service's API. --client names the client kind, and --client-session-env names the environment variable holding the client's own session id. It exits when the client closes stdin.`;

export const UI_HELP = `usage: agentorg ui

Mint a one-time link that signs a browser in to the decisions page, and print it. In a terminal it also opens the link, with BROWSER or the system's opener. The link works once, for five minutes. \`agentorg ui login-link\` prints the link as JSON.`;

/**
 * Print a one-time link that signs a browser in to the decisions page, and open it when run in a
 * terminal, with `BROWSER` or the system's opener. Run from a script or a pipe, it only prints.
 */
export async function openPage(): Promise<number> {
  const link = await remoteOperations().ui_login_link({}, CALLER);
  const url = serviceUrl() + link.path;
  process.stdout.write(`${url}\n`);
  if (!process.stdout.isTTY) return 0;
  const platform = process.platform;
  const opener =
    process.env.BROWSER ||
    (platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open");
  spawn(opener, [url], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
  return 0;
}

export const ASK_WAIT_HELP =
  "Waits for the ask in the background, asking the service again every 30 seconds and across its restarts, and prints the ask as JSON once it is settled. Exit status: 0 when the ask is answered, 2 when it is withdrawn, 1 when the timeout passes with it still open or on an error.";

export async function askWait(request: {
  ask: string;
  timeout_seconds: number | null;
}): Promise<number> {
  const operations = remoteOperations();
  const deadline =
    request.timeout_seconds === null ? null : Date.now() + request.timeout_seconds * 1000;
  let retry = 1;
  for (;;) {
    const step =
      deadline === null
        ? POLL_SECONDS
        : Math.max(Math.min(POLL_SECONDS, (deadline - Date.now()) / 1000), 0.001);
    let ask: z.output<typeof Ask>;
    try {
      ask = await operations.ask_wait({ ask: request.ask, timeout_seconds: step }, CALLER);
    } catch (error) {
      if (!(error instanceof Unavailable) || (deadline !== null && Date.now() >= deadline))
        throw error;
      note(`${error.message}; trying again in ${retry}s`);
      await new Promise((resolve) => setTimeout(resolve, retry * 1000));
      retry = Math.min(retry * 2, 30);
      continue;
    }
    retry = 1;
    if (ask.state === "open" && (deadline === null || Date.now() < deadline)) continue;
    print(ask);
    if (ask.state === "answered") return 0;
    note(`the ask is ${ask.state === "open" ? "still open" : ask.state}`);
    return ask.state === "withdrawn" ? 2 : 1;
  }
}

export const SESSION_CONTEXT_HELP =
  "For a client's session-start hook: prints the facts of a client session already attached, as JSON. Prints nothing and exits 0 when no session with that client session id is attached or the service is not running.";

export async function sessionContext(request: {
  client?: string;
  client_session_id?: string;
}): Promise<number> {
  try {
    const { facts } = await remoteOperations().session_context(request, CALLER);
    if (facts !== null) print(facts);
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
  }
  return 0;
}

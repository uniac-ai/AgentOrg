import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub, listen, PERSON } from "@agentorg/hub";
import {
  accountLogin,
  agents,
  connections,
  hubActors,
  hubAudit,
  hubBindings,
  hubExports,
  hubGrants,
  hubPackages,
  skills,
} from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { WebSocketServer } from "ws";
import { type PersonSide, serveSocket } from "./api.js";
import { Notes } from "./notes.js";
import { oauthRoute } from "./oauth.js";
import {
  closePackageActors,
  type Programs,
  type ProgramsOptions,
  startPrograms,
} from "./programs.js";
import { SignIn } from "./signin.js";

/**
 * The person's slots the gateway declares: every `hub.*` it holds, and what the first run binds
 * (any may be unbound): `login`, the model's account sign-in, and management's three.
 */
const SLOTS = {
  packages: hubPackages,
  actors: hubActors,
  bindings: hubBindings,
  grants: hubGrants,
  exports: hubExports,
  audit: hubAudit,
  login: accountLogin,
  agents,
  connections,
  skills,
};
const STATIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "static");
/** The shell's built files, `@agentorg/shell`'s `dist`. */
const SHELL = join(
  dirname(createRequire(import.meta.url).resolve("@agentorg/shell/package.json")),
  "dist",
);
/** A request body the gateway reads: a sign-in code, nothing more. */
const MAX_BODY = 1024;
/** One `/api` message. */
const MAX_MESSAGE = 1024 * 1024;
/** How long a tab's socket has to say its session. */
const HELLO_TIMEOUT_MS = 10_000;
/** The close code for a socket with no live session: the tab signs in again. */
const SIGN_IN_AGAIN = 4401;

/** A route another part of the app adds, such as the model Actor's sign-in callback (step 5). */
export type Route = (request: IncomingMessage, response: ServerResponse, url: URL) => void;

export interface AppOptions {
  /** The Hub home. */
  home: string;
  /** The gateway's port on 127.0.0.1; any free one by default. */
  port?: number;
  /** Where the shell's static files are; `@agentorg/shell`'s build by default. */
  shell?: string;
  /**
   * How the first run, at each start, logs and reaches ChatGPT: the app's own by default.
   */
  firstRun?: Pick<ProgramsOptions, "fetch" | "log">;
}

export interface App {
  /** The gateway's origin, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Where external Actors reach the Hub. */
  readonly hubUrl: string;
  readonly hub: Hub;
  /** This start's first run: the programs it started, once it's done. */
  readonly firstRun: Promise<Programs | undefined>;
  /** A fresh one-time sign-in address, `<url>/signin#<code>`. */
  signInUrl(): string;
  /** Serve `path` with `route`, for another part of the app. */
  route(path: string, route: Route): void;
  close(): Promise<void>;
  /**
   * Settles once the app has stopped: `lost` when the person's channel ended under it (another
   * program took it, or the Hub went), so it stopped itself.
   */
  readonly closed: Promise<{ lost: boolean }>;
}

/** Write a file only its owner reads, all at once. */
function writePrivate(file: string, text: string) {
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  chmodSync(file, 0o600);
}

/**
 * The app: a Hub in this process, and the person's gateway, its single running instance. The
 * gateway holds the person's one channel to the Hub. Browser tabs and the CLI are the person's UIs,
 * not channels: they reach the gateway at `/api`, and their calls run through the person's slots,
 * and the person's notes are the app's own file.
 */
export async function startApp(options: AppOptions): Promise<App> {
  const home = resolve(options.home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  closePackageActors(home);
  // Nothing uses the built-in storage, and `storage.db` is never opened.
  const hub = Hub.open(home, { builtinStorage: false });
  const listener = await listen(hub, {}).catch((error) => {
    hub.close();
    throw error;
  });
  writePrivate(join(home, "url"), `${listener.url}\n`);

  const signIn = new SignIn();
  const credential = readFileSync(join(home, "person-credential"), "utf8").trim();
  /** The app's own notes: what the shell remembers. */
  const notes = new Notes(join(home, "app-notes.json"));
  const person = await connect({
    hubUrl: listener.url,
    actorId: PERSON,
    credential,
    slots: SLOTS,
  }).catch((error) => {
    void listener.close();
    hub.close();
    throw error;
  });

  /** A slot exposed to the person at run time: here exactly while it is bound. */
  const exposedSlot = (slot: string) => person.exposed().find((one) => one.slot === slot);
  const personSide: PersonSide = {
    async call(slot, method, input) {
      if (slot === "store") return notes.call(method, input);
      const exposed = Object.hasOwn(SLOTS, slot) ? undefined : exposedSlot(slot);
      if (!exposed && !Object.hasOwn(SLOTS, slot))
        throw new Refused("invalid", `The person has no slot ${slot}.`);
      const calls = (exposed?.call ?? person.slots[slot as keyof typeof SLOTS].call) as Record<
        string,
        ((input: unknown) => Promise<unknown>) | undefined
      >;
      const call = Object.hasOwn(calls, method) ? calls[method] : undefined;
      if (!call) throw new Refused("invalid", `${slot} has no method ${method}.`);
      return call(input);
    },
    subscribe(slot, event, send) {
      const exposed = Object.hasOwn(SLOTS, slot) ? undefined : exposedSlot(slot);
      if (!exposed && !Object.hasOwn(SLOTS, slot))
        throw new Refused("invalid", `The person has no slot ${slot}.`);
      const handle = (exposed ?? person.slots[slot as keyof typeof SLOTS]) as unknown as {
        on(event: string, fn: (payload: unknown) => void): () => void;
      };
      try {
        return handle.on(event, send);
      } catch {
        throw new Refused("invalid", `${slot} has no event ${event}.`);
      }
    },
  };
  // The first run, beside serving: the shell follows the person's bindings as they're made, so it
  // needn't wait. What it can't do is logged and tried at the next start.
  const ran = startPrograms(personSide, {
    home,
    hubUrl: listener.url,
    log: (message) => process.stderr.write(`${message}\n`),
    ...options.firstRun,
  }).catch((error: unknown) => {
    process.stderr.write(
      `First run didn't work: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  });

  /** The app's own pages: scripts and styles from here only, framed by nothing. */
  const appCsp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  // Where ChatGPT sends the browser back after sign-in.
  const routes = new Map<string, Route>([["/oauth/chatgpt", oauthRoute(personSide)]]);
  let origin = "";
  const host = () => origin.slice("http://".length);

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    // Loopback only answers its own name: a page that rebinds DNS to 127.0.0.1 gets nothing.
    if (request.headers.host !== host()) return void response.writeHead(421).end();
    const url = new URL(request.url ?? "/", origin);
    const route = routes.get(url.pathname);
    if (route) return route(request, response, url);
    if (url.pathname === "/api/session" && request.method === "POST") {
      // Same-origin only: a cross-site form can't trade a code it saw.
      if (request.headers.origin !== origin) return void response.writeHead(403).end();
      const body = await readBody(request);
      let code: unknown;
      try {
        code = (JSON.parse(body) as { code?: unknown }).code;
      } catch {
        return void response.writeHead(400).end();
      }
      const session = signIn.redeem(code);
      if (!session) return void response.writeHead(403).end();
      // In the body, for the shell's own storage: a cookie would reach every port on 127.0.0.1.
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return void response.end(JSON.stringify({ session }));
    }
    if (url.pathname === "/api/code" && request.method === "POST") {
      // The CLI's way to sign a browser in again: a fresh code, for its token only.
      if (!signIn.isCli(request.headers.authorization)) return void response.writeHead(401).end();
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return void response.end(JSON.stringify({ code: signIn.code() }));
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return void response.writeHead(405).end();
    const file =
      url.pathname === "/signin" || url.pathname === "/signin.js"
        ? join(STATIC, url.pathname === "/signin" ? "signin.html" : "signin.js")
        : staticFile(options.shell ?? SHELL, url.pathname);
    if (!file) return void response.writeHead(404).end();
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      return void response.writeHead(404).end();
    }
    response.writeHead(200, {
      "Content-Type": contentType(file),
      "Content-Security-Policy": appCsp,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  server.on("upgrade", (request, socket, head) => {
    // An upgraded socket has no error handler of its own: a client that resets would crash the app.
    socket.on("error", () => socket.destroy());
    const url = new URL(request.url ?? "/", origin);
    const cli = signIn.isCli(request.headers.authorization);
    const allowed =
      request.headers.host === host() &&
      url.pathname === "/api" &&
      (cli || request.headers.origin === origin);
    if (!allowed) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      let served: ReturnType<typeof serveSocket> | undefined;
      const serve = () => {
        served = serveSocket(
          { send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) },
          { person: personSide },
        );
      };
      // The CLI is in by its token; a tab says its session first, or is closed.
      if (cli) serve();
      const timer = cli
        ? undefined
        : setTimeout(() => ws.close(SIGN_IN_AGAIN, "No session"), HELLO_TIMEOUT_MS);
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        if (served) return served.receive(String(data));
        let hello: { op?: unknown; session?: unknown } | undefined;
        try {
          hello = JSON.parse(String(data));
        } catch {
          // Not a hello.
        }
        clearTimeout(timer);
        if (hello?.op !== "hello" || !signIn.isSession(hello.session))
          return ws.close(SIGN_IN_AGAIN, "Sign in again");
        serve();
        ws.send(JSON.stringify({ op: "hello" }));
      });
      ws.on("close", () => {
        clearTimeout(timer);
        served?.closed();
      });
    });
  });

  await new Promise<void>((done, failed) => {
    server.once("error", failed);
    server.listen(options.port ?? 0, "127.0.0.1", () => done());
  }).catch(async (error) => {
    person.close();
    await listener.close();
    hub.close();
    throw error;
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writePrivate(join(home, "cli-token"), `${signIn.cliToken}\n`);
  writePrivate(join(home, "app.json"), `${JSON.stringify({ url: origin, pid: process.pid })}\n`);

  let closing: Promise<void> | undefined;
  let stopped = () => {};
  let lost = false;
  const closed = new Promise<{ lost: boolean }>((done) => {
    stopped = () => done({ lost });
    // The person's channel gone (taken over, or the Hub gone): the gateway can't serve, so it stops.
    void person.closed.then(() => {
      if (!closing) {
        lost = true;
        void close();
      }
    });
  });
  const close = () => {
    closing ??= (async () => {
      // A first run still going finishes first, so it isn't cut off half way.
      const programs = await ran;
      const ours = (file: string, text: string) => {
        if (file === "cli-token") return text.trim() === signIn.cliToken;
        if (file === "url") return text.trim() === listener.url;
        try {
          return (JSON.parse(text) as { pid?: unknown }).pid === process.pid;
        } catch {
          return false;
        }
      };
      // Only ours: another app or Hub may have taken the home since.
      for (const file of ["app.json", "cli-token", "url"])
        try {
          if (ours(file, readFileSync(join(home, file), "utf8"))) rmSync(join(home, file));
        } catch {
          // Already gone.
        }
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      // server.close waits for every open connection; a tab still connected (a keep-alive request,
      // a socket reconnecting) would hold the app open, so they are all closed now.
      const serverClosed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await serverClosed;
      await programs?.close();
      person.close();
      await person.closed;
      await listener.close();
      hub.close();
      stopped();
    })();
    return closing;
  };
  return {
    url: origin,
    hubUrl: listener.url,
    hub,
    firstRun: ran,
    signInUrl: () => `${origin}/signin#${signIn.code()}`,
    route: (path, route) => void routes.set(path, route),
    close,
    closed,
  };
}

/** A file of the shell's static tree for a path, or none if it would leave the tree. */
function staticFile(root: string, path: string): string | undefined {
  const base = resolve(root);
  let relative: string;
  try {
    relative = path === "/" ? "index.html" : decodeURIComponent(path).slice(1);
  } catch {
    return undefined;
  }
  const file = normalize(join(base, relative));
  return file.startsWith(base + sep) ? file : undefined;
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done, failed) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        request.destroy();
        failed(new Refused("too_large", "The body is too large."));
      }
    });
    request.on("end", () => done(body));
    request.on("error", failed);
  });
}

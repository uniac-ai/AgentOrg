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
  appRules,
  connections,
  hubActors,
  hubAudit,
  hubBindings,
  hubExports,
  hubGrants,
  hubPackages,
  installer,
  layout,
  skills,
} from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { WebSocketServer } from "ws";
import { type PersonSide, serveSocket, type ViewCalls } from "./api.js";
import { serveFrame } from "./frames.js";
import { Layout } from "./layout.js";
import { oauthRoute } from "./model.js";
import { Notes } from "./notes.js";
import {
  closePackageActors,
  type Programs,
  type ProgramsOptions,
  startPrograms,
} from "./programs.js";
import { Rules } from "./rules.js";
import { SignIn } from "./signin.js";
import {
  MAX_TRANSFER,
  packageArchive,
  pinnedHashes,
  readSystem,
  withTemporaryFile,
  writeSystem,
} from "./transfer.js";

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
  /** The installer: nothing binds it now; what still names it goes with the package system. */
  installer,
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
   * The first run, at each start: on by default; `false` leaves the home as it is.
   */
  firstRun?: Pick<ProgramsOptions, "fetch" | "log"> | false;
}

export interface App {
  /** The gateway's origin, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Where external Actors reach the Hub. */
  readonly hubUrl: string;
  readonly hub: Hub;
  /** This start's first run: the programs it started, once it's done; none when it was off. */
  readonly firstRun?: Promise<Programs | undefined>;
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
 * or as a view's Actor for a view's. The gateway exports `layout@1`, kept in the person's store.
 */
export async function startApp(options: AppOptions): Promise<App> {
  const home = resolve(options.home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (options.firstRun !== false) closePackageActors(home);
  // With the first run on, nothing uses the built-in storage, and `storage.db` is never opened.
  const hub = Hub.open(home, { builtinStorage: options.firstRun === false });
  const listener = await listen(hub, {}).catch((error) => {
    hub.close();
    throw error;
  });
  writePrivate(join(home, "url"), `${listener.url}\n`);

  const signIn = new SignIn();
  const changes = new Set<() => void>();
  /** Who hears that a rule was turned on or off. */
  const ruleChanges = new Set<() => void>();
  let emitChanged = () => {};
  const isView = (actorId: string, module: string) => {
    try {
      const actor = hub.state.actor(actorId);
      if (actor.package === "external" || actor.package === "builtin" || actor.state === "closed")
        return false;
      const { modules } = hub.state.package(actor.package).manifest;
      return Object.hasOwn(modules, module) && modules[module]?.placement === "view";
    } catch {
      return false;
    }
  };

  const credential = readFileSync(join(home, "person-credential"), "utf8").trim();
  /** The app's own notes: the layout, the rules, what the shell remembers. */
  const notes = new Notes(join(home, "app-notes.json"));
  let logic: Layout | undefined;
  const person = await connect({
    hubUrl: listener.url,
    actorId: PERSON,
    credential,
    slots: SLOTS,
    exports: { layout },
    start(ctx) {
      logic = new Layout({
        store: () => ({
          get: async (key) => notes.get(key),
          set: async (key, value) => notes.set(key, value),
        }),
        isView,
        changed: () => emitChanged(),
      });
      const served = logic;
      ctx.exports.layout.implement({
        get: () => served.get(),
        // Who placed it is the caller the Hub names, never the input.
        place: (input, { caller }) => served.place(input, caller),
        remove: (input) => served.remove(input),
        move: (input) => served.move(input),
      });
      emitChanged = () => {
        ctx.exports.layout.emit("changed", {});
        for (const tell of [...changes]) tell();
      };
    },
  }).catch((error) => {
    void listener.close();
    hub.close();
    throw error;
  });
  const layoutLogic = logic as Layout;
  // However an Actor is closed, here or by an agent, its views leave the layout.
  person.slots.actors.on("changed", ({ actor }) => {
    if (hub.state.actor(actor).state === "closed")
      void layoutLogic.removeActor(actor).catch(() => {});
  });

  /** The person's side of `/api`: its slots, and `layout`, its own export, served here. */
  /** A slot exposed to the person at run time: here exactly while it is bound. */
  const exposedSlot = (slot: string) => person.exposed().find((one) => one.slot === slot);
  const personSide: PersonSide = {
    async call(slot, method, input) {
      if (slot === "store") return notes.call(method, input);
      if (slot === "rules") {
        // The person's named rules, the gateway's own, checked as a call through the Hub would be.
        const spec = Object.hasOwn(appRules.methods, method)
          ? appRules.methods[method as keyof typeof appRules.methods]
          : undefined;
        if (!spec) throw new Refused("invalid", `rules has no method ${method}.`);
        const parsed = spec.input.safeParse(input);
        if (!parsed.success)
          throw new Refused("invalid", `rules.${method}: ${parsed.error.message}`);
        const result =
          method === "set"
            ? await rules.set(parsed.data as { id: string; on: boolean })
            : await rules.list();
        const checked = spec.output.safeParse(result);
        if (!checked.success)
          throw new Refused("bad_output", `rules.${method}: ${checked.error.message}`);
        return checked.data;
      }
      if (slot === "layout") {
        const spec = Object.hasOwn(layout.methods, method)
          ? layout.methods[method as keyof typeof layout.methods]
          : undefined;
        if (!spec) throw new Refused("invalid", `layout has no method ${method}.`);
        const parsed = spec.input.safeParse(input);
        if (!parsed.success)
          throw new Refused("invalid", `layout.${method}: ${parsed.error.message}`);
        // Through /api, the caller is the person.
        const result = await (
          layoutLogic[method as keyof typeof layout.methods] as (i: unknown, by: string) => unknown
        )(parsed.data, PERSON);
        // Checked as a call through the Hub would be: what's stored may not fit.
        const checked = spec.output.safeParse(result);
        if (!checked.success)
          throw new Refused("bad_output", `layout.${method}: ${checked.error.message}`);
        return checked.data;
      }
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
      if (slot === "rules") {
        if (event !== "changed") throw new Refused("invalid", "rules has one event, changed.");
        const tell = () => send({});
        ruleChanges.add(tell);
        return () => void ruleChanges.delete(tell);
      }
      if (slot === "layout") {
        if (event !== "changed") throw new Refused("invalid", "layout has one event, changed.");
        const tell = () => send({});
        changes.add(tell);
        return () => void changes.delete(tell);
      }
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
  const views: ViewCalls = {
    call: (view, slot, method, input) => hub.viewCall(view.actor, view.module, slot, method, input),
    subscribe: (view, slot, event, send, end) =>
      hub.viewSubscribe(view.actor, view.module, slot, event, send, () => end()),
    slots: (view, onSlot) => hub.viewSlots(view.actor, view.module, onSlot),
    log: (view, level, message, fields) =>
      hub.viewLog(view.actor, view.module, {
        level,
        message,
        ...(fields ? { data: fields } : {}),
      }),
  };

  // The first run, beside serving: the shell follows the person's bindings as they're made, so it
  // needn't wait. What it can't do is logged and tried at the next start.
  const ran =
    options.firstRun === false
      ? undefined
      : startPrograms(personSide, {
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

  // The person's named rules: off until turned on; their engine starts once the first run is done.
  const rules = new Rules({
    person: personSide,
    log: (message) => process.stderr.write(`${message}\n`),
    changed: () => {
      for (const tell of [...ruleChanges]) tell();
    },
  });
  void Promise.resolve(ran)
    .then(() => rules.start())
    .catch((error: unknown) =>
      process.stderr.write(
        `The rules didn't start: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
    );

  /** The app's own pages: scripts and styles from here only, framed by nothing. */
  const appCsp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
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
    if (url.pathname.startsWith("/frames/")) {
      const served =
        request.method === "GET"
          ? serveFrame(url.pathname, origin, bundleOf, request.headers.origin)
          : undefined;
      if (!served) return void response.writeHead(404).end();
      response.writeHead(served.status, served.headers).end(served.body);
      return;
    }
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
    // A package's archive, and a system's file, both ways: for the person's UIs only, a tab by its
    // session and the CLI by its token, as a bearer, which no other page can send.
    if (url.pathname.startsWith("/packages") || url.pathname === "/system") {
      const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
      if (!signIn.isCli(request.headers.authorization) && !signIn.isSession(bearer))
        return void response.writeHead(401).end();
      return transfer(request, response, url);
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
  /** Answer a transfer's failure as `/api` answers a call's: `{error}`, with a fitting status. */
  const failure = (response: ServerResponse, error: unknown) => {
    const body =
      error instanceof Refused
        ? { name: "Refused", message: error.message, code: error.code }
        : error instanceof Error &&
            (error.name === "NotConnected" || error.name === "OutcomeUnknown")
          ? { name: error.name, message: error.message }
          : { name: "Refused", message: "The gateway couldn't handle this.", code: "internal" };
    const status =
      body.code === "too_large"
        ? 413
        : body.code === "invalid" || body.code === "unknown"
          ? 400
          : 409;
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: body }));
  };
  const sendFile = (response: ServerResponse, name: string, bytes: Uint8Array) => {
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\w.@-]/g, "_")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
  };
  /**
   * `GET /packages/<hash>.agentorg`: a stored package's archive. `POST /packages`: an archive to
   * add, verified by the Hub. `GET /system`: the system's file, its composition and every package
   * it pins. `POST /system`: a system file, its packages added (each one's hash checked against
   * its name), then imported with the person's authority.
   */
  const transfer = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    try {
      const archive = /^\/packages\/(sha256-[0-9a-f]{64})\.agentorg$/.exec(url.pathname);
      if (archive && request.method === "GET") {
        const hash = archive[1] as string;
        const bytes = packageArchive(home, hash);
        if (!bytes) throw new Refused("unknown", `No package ${hash}.`);
        const { manifest } = hub.state.package(hash);
        return sendFile(response, `${manifest.name}-${manifest.version}.agentorg`, bytes);
      }
      if (url.pathname === "/packages" && request.method === "POST") {
        const bytes = await readBytes(request, MAX_TRANSFER);
        const added = await withTemporaryFile(home, "upload.agentorg", bytes, (path) =>
          person.slots.packages.call.add({ path }),
        );
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        return void response.end(JSON.stringify(added));
      }
      if (url.pathname === "/system" && request.method === "GET") {
        const { composition } = await person.slots.installer.call.exportSystem({});
        const archives = new Map<string, Uint8Array>();
        for (const hash of pinnedHashes(composition)) {
          const bytes = packageArchive(home, hash);
          if (bytes) archives.set(hash, bytes);
        }
        return sendFile(response, "system.agentorg-system", writeSystem(composition, archives));
      }
      if (url.pathname === "/system" && request.method === "POST") {
        const { composition, packages } = readSystem(await readBytes(request, MAX_TRANSFER));
        // Named by its hash, so the Hub refuses an archive whose hash isn't its name.
        for (const [hash, bytes] of packages)
          await withTemporaryFile(home, `${hash}.agentorg`, bytes, (path) =>
            person.slots.packages.call.add({ path }),
          );
        const imported = await person.slots.installer.call.importSystem({ composition });
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        return void response.end(JSON.stringify(imported));
      }
      response.writeHead(405).end();
    } catch (error) {
      failure(response, error);
    }
  };
  const bundleOf = (hash: string, module: string) => {
    try {
      const entry = hub.state.package(hash).manifest.modules[module];
      if (entry?.placement !== "view") return undefined;
      const dir = join(home, "packages", hash);
      const file = resolve(dir, entry.entry);
      return file.startsWith(dir + sep) ? file : undefined;
    } catch {
      return undefined;
    }
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
          { person: personSide, views },
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
  const closed = new Promise<{ lost: boolean }>((done) => {
    stopped = () => done({ lost: false });
    // The person's channel gone (taken over, or the Hub gone): the gateway can't serve, so it stops.
    void person.closed.then(() => {
      if (!closing) {
        void close();
        done({ lost: true });
      }
    });
  });
  const close = () => {
    closing ??= (async () => {
      // A first run still going finishes first, so it isn't cut off half way.
      const programs = await ran;
      rules.close();
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
    ...(ran ? { firstRun: ran } : {}),
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

/** A request's body as bytes, up to `max`: past it, `Refused("too_large")`. */
function readBytes(request: IncomingMessage, max: number): Promise<Uint8Array> {
  return new Promise((done, failed) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        request.destroy();
        failed(new Refused("too_large", `A file here is ${max / 1024 / 1024} MiB at most.`));
      } else chunks.push(chunk);
    });
    request.on("end", () => done(new Uint8Array(Buffer.concat(chunks))));
    request.on("error", failed);
  });
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

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect } from "@agentorg/sdk/client";
import WebSocket from "ws";
import { type App, SignIn, startApp } from "../src/index.ts";

async function setup(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "agentorg-app-"));
  const app = await startApp({ home, firstRun: { log: () => {} } });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { app, home, token: readFileSync(join(home, "cli-token"), "utf8").trim() };
}

/** A session, the way the sign-in page gets one. */
async function signIn(app: App) {
  const code = new URL(app.signInUrl()).hash.slice(1);
  const response = await fetch(`${app.url}/api/session`, {
    method: "POST",
    headers: { Origin: app.url, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const session = response.ok
    ? ((await response.clone().json()) as { session: string }).session
    : undefined;
  return { response, code, session };
}

/** An `/api` socket and a way to call through it. */
function api(app: App, headers: Record<string, string>) {
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, { headers });
  let id = 0;
  const waiting = new Map<
    number,
    (reply: { result?: unknown; error?: { code?: string; name: string } }) => void
  >();
  const events: { sub: number; payload?: unknown; end?: boolean }[] = [];
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.id) waiting.get(message.id)?.(message);
    else events.push(message);
  });
  const closedWith = new Promise<number>((done) => socket.once("close", (code) => done(code)));
  const opened = new Promise<number>((done) => {
    socket.once("open", () => done(101));
    socket.once("unexpected-response", (_request, response) => done(response.statusCode ?? 0));
    socket.once("error", () => done(0));
  });
  return {
    opened,
    closedWith,
    events,
    close: () => socket.close(),
    send: (message: unknown) =>
      socket.send(typeof message === "string" ? message : JSON.stringify(message)),
    call: (slot: string, method: string, input: unknown = {}) =>
      new Promise<{ result?: unknown; error?: { code?: string; name: string } }>((done) => {
        const n = ++id;
        waiting.set(n, done);
        socket.send(JSON.stringify({ id: n, op: "call", slot, method, input }));
      }),
    subscribe: (sub: number, slot: string, event: string) =>
      socket.send(JSON.stringify({ sub, op: "subscribe", slot, event })),
  };
}

const until = async (condition: () => boolean, ms = 3000) => {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A request sent as written: `fetch` would normalize the path first. */
const raw = (app: App, path: string, headers: Record<string, string> = {}) =>
  new Promise<number>((done) => {
    const { port } = new URL(app.url);
    request(
      { host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      },
    ).end();
  });

test("a sign-in code works once, for the same origin, and gives a session in the body, no cookie", async (t) => {
  const { app } = await setup(t);
  const first = await signIn(app);
  assert.equal(first.response.status, 200);
  assert.match(first.session ?? "", /^[\w-]{43}$/);
  assert.equal(first.response.headers.get("set-cookie"), null);
  assert.equal(first.response.headers.get("cache-control"), "no-store");
  // Used: refused. From another origin: refused.
  const again = await fetch(`${app.url}/api/session`, {
    method: "POST",
    headers: { Origin: app.url },
    body: JSON.stringify({ code: first.code }),
  });
  assert.equal(again.status, 403);
  const code = new URL(app.signInUrl()).hash.slice(1);
  for (const origin of ["http://evil.example", "null"]) {
    const cross = await fetch(`${app.url}/api/session`, {
      method: "POST",
      headers: { Origin: origin },
      body: JSON.stringify({ code }),
    });
    assert.equal(cross.status, 403);
  }
});

test("a code expires after 60 s", () => {
  let now = 0;
  const signIn = new SignIn({ now: () => now });
  const code = signIn.code();
  now = 60_001;
  assert.equal(signIn.redeem(code), undefined);
  const fresh = signIn.code();
  now += 59_000;
  assert.ok(signIn.redeem(fresh));
});

test("/api takes a tab from its own origin saying a live session first, or the CLI's token", async (t) => {
  const { app, token } = await setup(t);
  const { session } = await signIn(app);
  // Refused at the upgrade: no origin of its own, or another bearer.
  for (const [what, headers] of [
    ["no origin", {}],
    ["another origin", { Origin: "http://evil.example" }],
    ["another bearer", { Authorization: "Bearer nope" }],
  ] as const) {
    const socket = api(app, headers);
    assert.equal(await socket.opened, 401, what);
    socket.close();
  }
  // In by the token, at once.
  const cli = api(app, { Authorization: `Bearer ${token}` });
  assert.equal(await cli.opened, 101);
  assert.ok((await cli.call("actors", "list")).result);
  cli.close();
  // A tab: its first message says a live session, or the socket closes, asking to sign in again.
  for (const [what, first] of [
    ["a forged session", { op: "hello", session: "forged" }],
    ["a call before hello", { id: 1, op: "call", slot: "actors", method: "list", input: {} }],
    ["no JSON", "hello"],
  ] as const) {
    const tab = api(app, { Origin: app.url });
    assert.equal(await tab.opened, 101, what);
    tab.send(first);
    assert.equal(await tab.closedWith, 4401, what);
  }
  const tab = api(app, { Origin: app.url });
  await tab.opened;
  tab.send({ op: "hello", session });
  await until(() => tab.events.some((e) => (e as { op?: string }).op === "hello"));
  assert.ok((await tab.call("actors", "list")).result);
  tab.close();
});

test("loopback answers only its own name, so DNS rebinding reaches nothing", async (t) => {
  const { app } = await setup(t);
  const { port } = new URL(app.url);
  const response = await new Promise<number>((done) => {
    // fetch() won't set Host, so a raw request does.
    import("node:http").then(({ request }) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/", headers: { Host: `evil.example:${port}` } },
        (res) => {
          res.resume();
          done(res.statusCode ?? 0);
        },
      );
      req.end();
    });
  });
  assert.equal(response, 421);
  assert.equal((await fetch(app.url)).status, 200);
});

test("the app leaves its address and the CLI's token in the home, readable by its owner only", async (t) => {
  const { app, home } = await setup(t);
  for (const file of ["app.json", "cli-token"])
    assert.equal(statSync(join(home, file)).mode & 0o777, 0o600, file);
  assert.equal(JSON.parse(readFileSync(join(home, "app.json"), "utf8")).url, app.url);
});

test("the app's pages carry their policy, and the shell's tree can't be left", async (t) => {
  const { app } = await setup(t);
  for (const path of ["/", "/signin", "/signin.js"]) {
    const response = await fetch(`${app.url}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  }
  for (const path of [
    "/../../package.json",
    "/..%2f..%2fpackage.json",
    "/%2e%2e/static/signin.js",
    "/%E0%A4%A",
  ])
    assert.equal(await raw(app, path), 404, path);
});

test("a socket's subscriptions end when asked, and it holds 256 at most", async (t) => {
  const { app, token } = await setup(t);
  const cli = api(app, { Authorization: `Bearer ${token}` });
  t.after(cli.close);
  await cli.opened;
  cli.subscribe(1, "actors", "changed");
  for (let sub = 2; sub <= 257; sub++) cli.subscribe(sub, "actors", "changed");
  await until(() => cli.events.some((e) => e.sub === 257));
  assert.deepEqual(
    cli.events.filter((e) => e.end).map((e) => e.sub),
    [257],
  );
  for (let sub = 1; sub <= 256; sub++) cli.send({ sub, op: "unsubscribe" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await cli.call("actors", "create", { name: "Heard by nobody" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(cli.events.filter((e) => e.payload).length, 0);
});

test("an upgrade that resets before it's refused doesn't stop the app", async (t) => {
  const { app } = await setup(t);
  const { port } = new URL(app.url);
  for (let i = 0; i < 30; i++) {
    const socket = connectTcp(Number(port), "127.0.0.1", () => {
      socket.write(
        `GET /api HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\n\r\n`,
      );
      socket.resetAndDestroy();
    });
    socket.on("error", () => {});
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await fetch(app.url)).status, 200);
});

test("the app stops itself when the person's channel is taken, and takes its files with it", async (t) => {
  const { app, home } = await setup(t);
  const credential = readFileSync(join(home, "person-credential"), "utf8").trim();
  const taker = await connect({ hubUrl: app.hubUrl, actorId: "person", credential });
  t.after(() => taker.close());
  assert.deepEqual(await app.closed, { lost: true });
  for (const file of ["app.json", "cli-token", "url"])
    assert.equal(existsSync(join(home, file)), false, file);
});

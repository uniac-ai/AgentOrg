import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { layout } from "@agentorg/interfaces";
import { buildPackage } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import WebSocket from "ws";
import { type App, SignIn, startApp } from "../src/index.ts";

// dist/test/gateway.test.js → the repository root.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function setup(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "agentorg-app-"));
  const app = await startApp({ home });
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
    call: (
      slot: string,
      method: string,
      input: unknown = {},
      view?: { actor: string; module: string },
    ) =>
      new Promise<{ result?: unknown; error?: { code?: string; name: string } }>((done) => {
        const n = ++id;
        waiting.set(n, done);
        socket.send(
          JSON.stringify({ id: n, op: "call", slot, method, input, ...(view ? { view } : {}) }),
        );
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

/** The board package, built and added, and an Actor that runs it. */
async function board(t: test.TestContext, cli: ReturnType<typeof api>) {
  const out = mkdtempSync(join(tmpdir(), "agentorg-board-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = await buildPackage(join(root, "examples", "board"), { out });
  const added = (await cli.call("packages", "add", { path: built.file })).result as {
    hash: string;
  };
  const created = (await cli.call("actors", "create", { name: "Board", package: added.hash }))
    .result as { actorId: string };
  return { hash: added.hash, actorId: created.actorId };
}

test("layout@1 places, moves and removes views, keeps them in the person's store, and tells of each change", async (t) => {
  const { app, token } = await setup(t);
  const cli = api(app, { Authorization: `Bearer ${token}` });
  t.after(cli.close);
  await cli.opened;
  const { actorId } = await board(t, cli);
  cli.subscribe(1, "layout", "changed");
  const placed = (
    await cli.call("layout", "place", { actor: actorId, module: "panel", title: "Launch" })
  ).result as { id: string };
  const second = (await cli.call("layout", "place", { actor: actorId, module: "panel" }))
    .result as {
    id: string;
  };
  const ids = async () =>
    ((await cli.call("layout", "get")).result as { home: { id: string }[] }).home.map((p) => p.id);
  assert.deepEqual(await ids(), [placed.id, second.id]);
  // Through /api, the person placed them; an input can't say otherwise.
  const byOf = async () =>
    ((await cli.call("layout", "get")).result as { home: { by?: string }[] }).home.map((p) => p.by);
  assert.deepEqual(await byOf(), ["person", "person"]);
  // With no `after`, a move goes first; with one, after it.
  await cli.call("layout", "move", { id: second.id });
  assert.deepEqual(await ids(), [second.id, placed.id]);
  await cli.call("layout", "move", { id: second.id, after: placed.id });
  assert.deepEqual(await ids(), [placed.id, second.id]);
  await cli.call("layout", "remove", { id: placed.id });
  assert.deepEqual(await ids(), [second.id]);
  // Kept in the person's own store, the built-in storage's.
  const kept = (await cli.call("store", "get", { key: "layout" })).result as {
    value: { id: string }[];
  };
  assert.deepEqual(
    kept.value.map((p) => p.id),
    [second.id],
  );
  await until(() => cli.events.filter((e) => e.sub === 1 && e.payload).length === 5);
  // Only a view module of a package Actor: not its host module, not an unknown Actor.
  for (const input of [
    { actor: actorId, module: "logic" },
    { actor: "nobody", module: "panel" },
    { actor: "person", module: "panel" },
  ]) {
    const refused = await cli.call("layout", "place", input);
    assert.equal(refused.error?.code, "invalid", JSON.stringify(input));
  }
  assert.equal((await cli.call("layout", "remove", { id: "gone" })).error?.code, "unknown");
  // A `by` in the input is no input of place's: dropped, and the caller recorded.
  await cli.call("layout", "place", { actor: actorId, module: "panel", by: "someone" });
  assert.equal((await byOf()).at(-1), "person");
  assert.equal((await cli.call("layout", "nope")).error?.code, "invalid");
});

test("a program bound to the person's layout places a view as the person does", async (t) => {
  const { app, token } = await setup(t);
  const cli = api(app, { Authorization: `Bearer ${token}` });
  t.after(cli.close);
  await cli.opened;
  const { actorId } = await board(t, cli);
  const made = (await cli.call("actors", "create", { name: "agent" })).result as {
    actorId: string;
    credential: string;
  };
  const agent = await connect({
    hubUrl: app.hubUrl,
    actorId: made.actorId,
    credential: made.credential,
    slots: { layout },
  });
  t.after(() => agent.close());
  const bound = await cli.call("grants", "bind", {
    consumer: made.actorId,
    slot: "layout",
    provider: "person",
    export: "layout",
  });
  assert.deepEqual(bound.result, { bound: true });
  await until(() => agent.slots.layout.bound);
  const { id } = await agent.slots.layout.call.place({ actor: actorId, module: "panel" });
  const home = (await cli.call("layout", "get")).result as { home: { id: string; by?: string }[] };
  // Placed by the agent, as the Hub named the caller.
  assert.deepEqual(
    home.home.map((p) => [p.id, p.by]),
    [[id, made.actorId]],
  );
});

test("a view's call goes to the Hub as its Actor's, which refuses one with no package or not running", async (t) => {
  const { app, token } = await setup(t);
  const cli = api(app, { Authorization: `Bearer ${token}` });
  t.after(cli.close);
  await cli.opened;
  const { actorId } = await board(t, cli);
  const asView = (actor: string, module: string) =>
    cli.call("board", "list", {}, { actor, module });
  // The Hub decides: an Actor with no package has no views; a package Actor's must be running.
  assert.equal((await asView("person", "panel")).error?.code, "forbidden");
  assert.equal((await asView(actorId, "panel")).error?.code, "state");
  assert.equal((await asView("", "panel")).error?.code, "invalid");
});

test("/frames/ serves a view's bundle under the frame policy, and nothing else", async (t) => {
  const { app, token } = await setup(t);
  const cli = api(app, { Authorization: `Bearer ${token}` });
  t.after(cli.close);
  await cli.opened;
  const { hash } = await board(t, cli);
  const runtime = await fetch(`${app.url}/frames/runtime.js`);
  assert.equal(runtime.status, 200);
  // Readable across origins by a sandboxed frame only, whose Origin is null: no page needs it.
  assert.equal(runtime.headers.get("access-control-allow-origin"), null);
  for (const path of ["/frames/runtime.js", `/frames/${hash}/panel.js`]) {
    const allowed = async (from: string) =>
      (await fetch(`${app.url}${path}`, { headers: { Origin: from } })).headers.get(
        "access-control-allow-origin",
      );
    assert.equal(await allowed("null"), "null", path);
    assert.equal(await allowed(app.url), null, path);
    assert.equal(await allowed("https://example.com"), null, path);
  }
  const csp = runtime.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, new RegExp(`script-src ${app.url}/frames/(;|$)`));
  assert.match(csp, /connect-src 'none'/);
  const page = await fetch(`${app.url}/frames/${hash}/panel.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /src="\/frames\/runtime.js"/);
  const bundle = await fetch(`${app.url}/frames/${hash}/panel.js`);
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("cache-control") ?? "", /immutable/);
  for (const path of [
    `/frames/${hash}/logic.js`,
    `/frames/${hash}/logic.html`,
    `/frames/${hash}/../agentorg.json`,
    "/frames/sha256-0/panel.js",
    `/frames/${hash}/..%2fagentorg.json`,
  ])
    assert.equal(await raw(app, path), 404, path);
  // Its own policy sandboxes the frame document, however it is opened.
  assert.match(page.headers.get("content-security-policy") ?? "", /; sandbox allow-scripts$/);
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
  cli.subscribe(1, "layout", "changed");
  for (let sub = 2; sub <= 257; sub++) cli.subscribe(sub, "layout", "changed");
  await until(() => cli.events.some((e) => e.sub === 257));
  assert.deepEqual(
    cli.events.filter((e) => e.end).map((e) => e.sub),
    [257],
  );
  for (let sub = 1; sub <= 256; sub++) cli.send({ sub, op: "unsubscribe" });
  const { actorId } = await board(t, cli);
  await cli.call("layout", "place", { actor: actorId, module: "panel" });
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

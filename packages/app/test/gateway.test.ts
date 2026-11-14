import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hub } from "@agentorg/hub";
import { connect } from "@agentorg/sdk/client";
import WebSocket from "ws";
import { FRONTEND_CONTRACT, frontendOf, HUB_OPTIONS } from "../src/gateway.ts";
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

/** Apps on one home, one after another, each closed before the home goes. */
function restarting(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "agentorg-app-"));
  const apps: App[] = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    /** Start on the home, at `port`, or where the app itself chooses. */
    async start(port?: number) {
      const app = await startApp({ home, firstRun: { log: () => {} }, ...(port ? { port } : {}) });
      apps.push(app);
      return app;
    },
  };
}
/** Something else listening on `port`, until the test ends. */
async function taking(t: test.TestContext, port: number) {
  const other = createTcpServer();
  t.after(() => other.close());
  await new Promise<void>((done, failed) =>
    other.once("error", failed).listen(port, "127.0.0.1", done),
  );
  return other;
}
/** What a tab saying `session` first gets: its call answered, or the code its socket closes with. */
async function tabWith(app: App, session: string) {
  const tab = api(app, { Origin: app.url });
  await tab.opened;
  tab.send({ op: "hello", session });
  const got = await Promise.race([
    tab.call("actors", "list").then((reply) => (reply.error ? "refused" : "answered")),
    tab.closedWith,
  ]);
  tab.close();
  return got;
}

test("a tab stays signed in when the app starts again at its address, and no other session is taken", async (t) => {
  const { home, start } = restarting(t);
  const first = await start();
  const port = Number(new URL(first.url).port);
  const session = (await signIn(first)).session as string;
  const unused = new URL(first.signInUrl()).hash.slice(1);
  const token = readFileSync(join(home, "cli-token"), "utf8").trim();
  assert.equal(await tabWith(first, session), "answered");
  // What is kept is not the session: reading the file signs no one in.
  const kept = readFileSync(join(home, "sessions.json"), "utf8");
  assert.ok(!kept.includes(session));
  assert.equal(statSync(join(home, "sessions.json")).mode & 0o777, 0o600);
  await first.close();

  const second = await start(port);
  assert.equal(second.url, first.url);
  assert.equal(await tabWith(second, session), "answered", "the session from before");
  assert.equal(await tabWith(second, "a-session-nobody-was-given"), 4401);
  for (const hash of (JSON.parse(kept) as { hashes: string[] }).hashes)
    assert.equal(await tabWith(second, hash), 4401, "what the file holds is no session");
  // A code and the CLI's token don't outlast the app.
  const late = await fetch(`${second.url}/api/session`, {
    method: "POST",
    headers: { Origin: second.url, "Content-Type": "application/json" },
    body: JSON.stringify({ code: unused }),
  });
  assert.equal(late.status, 403);
  assert.notEqual(readFileSync(join(home, "cli-token"), "utf8").trim(), token);
});

test("with no port asked for, the app takes the address its kept sessions are for; when it can't, they are dropped for good", async (t) => {
  const { start } = restarting(t);
  const first = await start();
  const session = (await signIn(first)).session as string;
  await first.close();
  const second = await start();
  assert.equal(second.url, first.url);
  assert.equal(await tabWith(second, session), "answered");
  await second.close();

  // Something else has the port: the app starts elsewhere, as on a first start. What a tab left
  // on the old address goes on saying there is worth nothing, even once the app is back on it.
  const port = Number(new URL(first.url).port);
  const other = await taking(t, port);
  const third = await start();
  assert.notEqual(third.url, first.url);
  await third.close();
  await new Promise((done) => other.close(done));
  const back = await start(port);
  assert.equal(back.url, first.url);
  assert.equal(await tabWith(back, session), 4401);
});

test("a port that was asked for and is taken is an error, not another port", async (t) => {
  const { start } = restarting(t);
  const first = await start();
  const port = Number(new URL(first.url).port);
  await first.close();
  await taking(t, port);
  await assert.rejects(start(port), { code: "EADDRINUSE" });
});

test("sessions that don't read back are no reason not to start: everyone signs in again", async (t) => {
  const { home, start } = restarting(t);
  const first = await start();
  const session = (await signIn(first)).session as string;
  await first.close();
  writeFileSync(join(home, "sessions.json"), "not json");
  const second = await start(Number(new URL(first.url).port));
  assert.equal(await tabWith(second, session), 4401);
  assert.equal(await tabWith(second, (await signIn(second)).session as string), "answered");
});

test("the sessions kept are the newest 256, the oldest dropped first", () => {
  const written: string[][] = [];
  const kept = { read: () => written.at(-1), write: (hashes: string[]) => written.push(hashes) };
  const signIn = new SignIn({ kept });
  // 258 given: the first two are dropped.
  const sessions = Array.from({ length: 258 }, () => signIn.redeem(signIn.code()) as string);
  assert.equal(written.at(-1)?.length, 256);
  const again = new SignIn({ kept });
  assert.deepEqual(
    [sessions[0], sessions[1], sessions[2], sessions.at(-1)].map((one) => again.isSession(one)),
    [false, false, true, true],
  );
  // What isn't a list of strings is read as far as it is one, and never throws.
  const last = sessions.at(-1) as string;
  const odd = new SignIn({ kept: { read: () => [7, null, written.at(-1)?.at(-1)], write() {} } });
  assert.equal(odd.isSession(last), true);
  assert.equal(new SignIn({ kept: { read: () => ({ a: 1 }), write() {} } }).isSession(last), false);
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
  // A call is answered after all that was sent before it, so they have all ended by now. What the
  // first run did before this was heard, as it should be, so only what comes after counts.
  await cli.call("actors", "list");
  const from = cli.events.length;
  cli.subscribe(258, "actors", "changed");
  await cli.call("actors", "create", { name: "Heard by one" });
  await until(() => cli.events.slice(from).some((e) => e.sub === 258));
  assert.deepEqual(
    cli.events.slice(from).filter((e) => e.sub !== 258),
    [],
  );
});

test("a live socket is the tab's own: same origin, then its session, before anything opens", async (t) => {
  const { app, token } = await setup(t);
  const { session } = await signIn(app);
  const at = `${app.url.replace("http", "ws")}/live?agent=act_none&instance=uni_none&surface=terminal`;
  const opened = (headers: Record<string, string>) =>
    new Promise<{ status?: number; closed?: number; reason?: string }>((done) => {
      const socket = new WebSocket(at, { headers });
      socket.once("unexpected-response", (_request, response) =>
        done({ status: response.statusCode }),
      );
      socket.once("open", () => {
        if (session && headers.Origin === app.url)
          socket.send(JSON.stringify({ op: "hello", session: headers.session ?? session }));
      });
      socket.once("close", (code, reason) => done({ closed: code, reason: String(reason) }));
    });
  assert.equal((await opened({ Origin: "https://elsewhere.example" })).status, 401);
  assert.deepEqual(
    (await opened({ Origin: app.url, session: "not-a-session" })).closed,
    4401,
    "a session it doesn't have",
  );
  const refused = await opened({ Origin: app.url });
  assert.equal(refused.closed, 4404);
  assert.ok(refused.reason, "it says why");
  // Nor does /api hand a page a ticket, under any slot.
  const cli = api(app, { Authorization: `Bearer ${token}` });
  t.after(cli.close);
  await cli.opened;
  for (const slot of ["agents", "elsewhere"])
    assert.equal(
      (await cli.call(slot, "live", { agent: "a", instance: "i", surface: "s", mode: "watch" }))
        .error?.code,
      "forbidden",
    );
});

test("a call to a slot the person doesn't have is refused `invalid`, and the socket goes on", async (t) => {
  const { app, token } = await setup(t);
  const cli = api(app, { Authorization: `Bearer ${token}` });
  t.after(cli.close);
  await cli.opened;
  // Once served, for a window that browsed for a folder; taken out because it listed any folder
  // on the machine.
  const { result, error } = await cli.call("folders", "list");
  assert.equal(result, undefined);
  assert.equal(error?.code, "invalid");
  // The socket goes on answering.
  assert.ok((await cli.call("actors", "list")).result);
});

test("a message too large is refused in words and its socket goes on; one too large to read closes its own socket only", async (t) => {
  const { app, token } = await setup(t);
  const headers = { Authorization: `Bearer ${token}` };
  const cli = api(app, headers);
  t.after(cli.close);
  await cli.opened;
  // A long paste, as a page sends one: over the most a message carries, so nothing of it is done.
  const pasted = await new Promise<{ error?: { code?: string; message?: string } }>((done) => {
    const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, { headers });
    t.after(() => socket.close());
    socket.once("open", () =>
      socket.send(
        JSON.stringify({
          id: 7,
          op: "call",
          slot: "actors",
          method: "list",
          input: { text: "x".repeat(2_250_000) },
        }),
      ),
    );
    socket.on("message", (data) => done(JSON.parse(String(data))));
  });
  assert.deepEqual(pasted, {
    id: 7,
    error: {
      name: "Refused",
      code: "invalid",
      message: "That's too large to send: one message to AgentOrg can be at most 1 MB.",
    },
  });
  // Too large even to read: that socket is closed, as a message too big, and no other.
  const huge = api(app, headers);
  await huge.opened;
  huge.send("x".repeat(17 * 1024 * 1024));
  assert.equal(await huge.closedWith, 1009);
  // Before it says its session, a tab's socket is read no further than one message carries.
  const tab = api(app, { Origin: app.url });
  await tab.opened;
  tab.send("x".repeat(2 * 1024 * 1024));
  assert.equal(await tab.closedWith, 4401);
  // The app, and the socket that was open beside it, go on answering.
  assert.ok((await cli.call("actors", "list")).result);
  const after = api(app, headers);
  t.after(after.close);
  await after.opened;
  assert.ok((await after.call("actors", "list")).result);
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

test("the app gives a model's reply ten minutes; other interfaces keep the Hub's own limit", async (t) => {
  assert.deepEqual(HUB_OPTIONS, { answerTimeoutsMs: { "llm.session@1": 600_000 } });
  const open = t.mock.method(Hub, "open");
  await setup(t);
  assert.equal(open.mock.calls[0]?.arguments[1], HUB_OPTIONS);
});

test("the core serves the frontend it is given, and its own sign-in page beside it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-app-"));
  const frontend = join(home, "frontend");
  mkdirSync(frontend);
  writeFileSync(join(frontend, "index.html"), "<p>given</p>");
  writeFileSync(
    join(frontend, "frontend.json"),
    JSON.stringify({ version: "0.0.0-test", contract: FRONTEND_CONTRACT }),
  );
  const app = await startApp({ home, frontend, firstRun: { log: () => {} } });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(app.frontend, frontend);
  assert.equal(await (await fetch(`${app.url}/`)).text(), "<p>given</p>");
  assert.equal((await fetch(`${app.url}/signin`)).status, 200);
  assert.equal((await fetch(`${app.url}/app.js`)).status, 404, "only what the folder has");
});

test("a frontend of another contract, or a folder that isn't one, is refused before anything starts", async () => {
  const folder = mkdtempSync(join(tmpdir(), "agentorg-frontend-"));
  try {
    // Nothing of the home is made for a start that is refused.
    const home = join(folder, "home");
    await assert.rejects(startApp({ home, frontend: folder }), /isn't a frontend/);
    assert.equal(existsSync(home), false);
    assert.throws(() => frontendOf(folder), /isn't a frontend: it has no index\.html/);
    writeFileSync(join(folder, "index.html"), "<p>one</p>");
    assert.equal(frontendOf(folder), folder, "with no frontend.json, it speaks the first");
    writeFileSync(join(folder, "frontend.json"), JSON.stringify({ version: "9.9.9", contract: 2 }));
    assert.throws(
      () => frontendOf(folder),
      /, 9\.9\.9, speaks contract 2, and this core, .+, speaks contract 1\. Use the frontend of the same release/,
    );
    for (const unreadable of ["{", "null", "[2]", "5"]) {
      writeFileSync(join(folder, "frontend.json"), unreadable);
      assert.throws(() => frontendOf(folder), /frontend\.json can't be read/, unreadable);
    }
    writeFileSync(join(folder, "frontend.json"), JSON.stringify({ contract: "1" }));
    assert.throws(() => frontendOf(folder), /speaks contract "1", and this core/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

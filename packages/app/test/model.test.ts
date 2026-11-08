import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { accountLogin } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { buildPackage, verifyPackage } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import { installAgent } from "@agentorg/shell/agent-bindings";
import WebSocket from "ws";
import { type App, firstRun, startApp } from "../src/index.ts";

// dist/test/model.test.js → dist/bundled, the app's bundled packages; the app's folder; the root.
const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "bundled");
const appFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = join(appFolder, "..", "..");

/**
 * The bundle an earlier release shipped, as far as a first run can tell: the installer, ChatGPT
 * and the assistant built again under another version, so each is another package, and the board.
 */
async function earlierBundle(t: test.TestContext) {
  const dir = join(appFolder, ".test-fixtures", `earlier-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "bundled");
  mkdirSync(out, { recursive: true });
  const index = JSON.parse(readFileSync(join(bundled, "index.json"), "utf8")) as Record<
    string,
    string
  >;
  const earlier: Record<string, string> = {};
  for (const name of ["installer", "chatgpt", "assistant"]) {
    const source = join(dir, name);
    cpSync(join(root, "packages", name), source, {
      recursive: true,
      filter: (path) => !/\/(node_modules|dist|agentorg-build)(\/|$)/.test(path),
    });
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({ ...manifest, version: `${manifest.version}-earlier` }),
    );
    const built = await buildPackage(source, { out: join(dir, `${name}-out`) });
    cpSync(built.file, join(out, `${built.hash}.agentorg`));
    earlier[name] = `${built.hash}.agentorg`;
  }
  cpSync(join(bundled, index.board as string), join(out, index.board as string));
  writeFileSync(join(out, "index.json"), JSON.stringify({ ...earlier, board: index.board }));
  return out;
}
const until = async (condition: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((done) => setTimeout(done, 50));
  }
};

/** The person through the CLI's way in, with `call` as the first run takes it. */
function personOf(app: App, home: string) {
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
    headers: { Authorization: `Bearer ${readFileSync(join(home, "cli-token"), "utf8").trim()}` },
  });
  const opened = new Promise((done) => socket.once("open", done));
  let id = 0;
  const waiting = new Map<number, (reply: { result?: unknown; error?: unknown }) => void>();
  socket.on("message", (data) => {
    const reply = JSON.parse(String(data));
    waiting.get(reply.id)?.(reply);
  });
  return {
    close: async () => {
      await opened;
      socket.close();
    },
    async call(slot: string, method: string, input: unknown = {}): Promise<unknown> {
      await opened;
      const reply = await new Promise<{ result?: unknown; error?: unknown }>((done) => {
        waiting.set(++id, done);
        socket.send(JSON.stringify({ id, op: "call", slot, method, input }));
      });
      if (reply.error) {
        const { name, code } = reply.error as { name?: string; code?: string };
        throw Object.assign(new Error(JSON.stringify(reply.error)), { name, code });
      }
      return reply.result;
    },
  };
}

async function setup(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "agentorg-first-run-"));
  const app = await startApp({ home, firstRun: false });
  const person = personOf(app, home);
  t.after(async () => {
    await person.close();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  });
  const actors = async () =>
    (
      (await person.call("actors", "list")) as {
        actors: { actorId: string; name: string; state: string }[];
      }
    ).actors.filter((a) => a.state !== "closed");
  const wiring = async (actor: string) =>
    (
      (await person.call("bindings", "list", { actor })) as {
        bindings: { consumer: string; slot: string; provider: string; export: string }[];
      }
    ).bindings
      .filter((b) => b.consumer === actor)
      .map((b) => `${b.slot} ${b.provider}.${b.export}`)
      .sort();
  return { app, home, person, actors, wiring };
}

/** A GET to the app, as a browser coming back from ChatGPT would make it. */
function get(app: App, path: string, method = "GET") {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (done, fail) => {
      const req = request(`${app.url}${path}`, { method }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          done({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      });
      req.on("error", fail);
      req.end();
    },
  );
}

test("the bundled packages are the four first run adds, each verified and named", async () => {
  const index = JSON.parse(readFileSync(join(bundled, "index.json"), "utf8")) as Record<
    string,
    string
  >;
  assert.deepEqual(Object.keys(index).sort(), ["assistant", "board", "chatgpt", "installer"]);
  for (const [name, file] of Object.entries(index)) {
    const verified = await verifyPackage(join(bundled, file));
    assert.ok(verified.ok, `${name}: ${verified.ok ? "" : verified.problems.join("; ")}`);
    assert.equal(verified.manifest.name, name);
  }
});

test("first run makes the installer and ChatGPT once, bound as the person bound them", async (t) => {
  const { app, person, actors, wiring } = await setup(t);
  const logged: string[] = [];
  const ran = await firstRun(person, {
    connected: (id) => app.hub.connected(id),
    log: (message) => logged.push(message),
  }); // The assistant New agent installs is the bundled one, by hash.
  assert.deepEqual(
    ((await person.call("store", "get", { key: "app/first-run" })) as { value: object }).value,
    {
      installer: ran.installer,
      chatgpt: ran.chatgpt,
      assistant: ran.packages.assistant,
      // Every assistant build a run bundled, so an agent on one is known as the app's.
      assistants: [ran.packages.assistant],
    },
  );
  assert.deepEqual(Object.keys(ran.packages).sort(), [
    "assistant",
    "board",
    "chatgpt",
    "installer",
  ]);
  const installer = ran.installer as string;
  const chatgpt = ran.chatgpt as string;
  assert.ok(installer && chatgpt, logged.join("\n"));
  assert.deepEqual(await wiring(installer), [
    "installer.actors hub.actors",
    "installer.bindings hub.bindings",
    "installer.exports hub.exports",
    "installer.grants hub.grants",
    "installer.layout person.layout",
    "installer.packages hub.packages",
    "installer.storage storage.admin",
  ]);
  assert.deepEqual(await wiring(chatgpt), ["model.store storage.kv", "model.web net.egress"]);
  const person_ = await wiring("person");
  assert.ok(person_.includes(`installer ${installer}.installer.installer`));
  assert.ok(person_.includes(`login ${chatgpt}.model.login`));
  const states = Object.fromEntries((await actors()).map((a) => [a.actorId, a.state]));
  assert.equal(states[installer], "running");
  assert.equal(states[chatgpt], "running");
  await until(() => app.hub.connected(chatgpt));
  assert.deepEqual((await person.call("login", "status")) as object, { state: "signed_out" });

  // Again, as at every start: nothing new is made, and nothing is bound twice.
  const before = (await actors()).length;
  const again = await firstRun(person, { connected: (id) => app.hub.connected(id) });
  assert.deepEqual(again, ran);
  assert.equal((await actors()).length, before);
  assert.deepEqual(await wiring("person"), person_);
});

test("New agent from a test: installAgent with what the first run made", async (t) => {
  const { app, person, wiring } = await setup(t);
  // Before any first run there's no ChatGPT or installer of the person's to connect to.
  await assert.rejects(installAgent(person.call, { assistant: "x", name: "Early" }), {
    message: "AgentOrg isn't set up yet. Restart it to finish setting up.",
  });
  const ran = await firstRun(person, { connected: (id) => app.hub.connected(id) });
  const { actorId: agent, unbound } = await installAgent(person.call, {
    assistant: ran.packages.assistant as string,
    name: "Scout",
    off: new Set(["packages", "actors"]),
  });
  await until(() => app.hub.connected(agent));
  assert.deepEqual(await wiring(agent), [
    `chat.chat ${agent}.logic.chat`,
    "logic.exports hub.exports",
    "logic.grants hub.grants",
    `logic.installer ${ran.installer}.installer.installer`,
    "logic.layout person.layout",
    `logic.model ${ran.chatgpt}.model.session`,
    "logic.store storage.kv",
  ]);
  // Its grants left unbound: the switched-off ones.
  assert.deepEqual(unbound.filter((slot) => slot.startsWith("logic.")).sort(), [
    "logic.actors",
    "logic.packages",
  ]);
});

test("a first run that stopped half way converges at the next", async (t) => {
  const { app, person, actors, wiring } = await setup(t);
  const ran = await firstRun(person, { connected: (id) => app.hub.connected(id) });
  const installer = ran.installer as string;
  const chatgpt = ran.chatgpt as string;
  const whole = await wiring(installer);
  await person.call("grants", "unbind", { consumer: installer, slot: "installer.storage" });
  await person.call("grants", "unbind", { consumer: "person", slot: "login" });
  await person.call("grants", "unbind", { consumer: chatgpt, slot: "model.web" });
  await person.call("actors", "stop", { actorId: chatgpt });
  await person.call("actors", "stop", { actorId: installer });
  assert.deepEqual(await firstRun(person, { connected: (id) => app.hub.connected(id) }), ran);
  assert.deepEqual(await wiring(installer), whole);
  assert.deepEqual(await wiring(chatgpt), ["model.store storage.kv", "model.web net.egress"]);
  assert.ok((await wiring("person")).includes(`login ${chatgpt}.model.login`));
  const states = Object.fromEntries((await actors()).map((a) => [a.actorId, a.state]));
  assert.deepEqual([states[installer], states[chatgpt]], ["running", "running"]);
});

test("first run trusts only the Actors it made: never one by its package's name", async (t) => {
  const { app, person, wiring } = await setup(t);
  const connected = (id: string) => app.hub.connected(id);
  // An Actor whose package calls itself "installer", made by someone else, before any first run.
  const index = JSON.parse(readFileSync(join(bundled, "index.json"), "utf8")) as Record<
    string,
    string
  >;
  const { hash } = (await person.call("packages", "add", {
    path: join(bundled, index.installer as string),
  })) as { hash: string };
  const { actorId: other } = (await person.call("actors", "create", {
    name: "Not the app's",
    package: hash,
  })) as { actorId: string };
  const ran = await firstRun(person, { connected });
  assert.ok(ran.installer && ran.installer !== other);
  assert.deepEqual(await wiring(other), []);
  assert.ok((await wiring("person")).includes(`installer ${ran.installer}.installer.installer`));

  // Its own ChatGPT closed: the next run installs another, and the login follows it.
  await person.call("actors", "close", { actorId: ran.chatgpt });
  const again = await firstRun(person, { connected });
  assert.equal(again.installer, ran.installer);
  assert.ok(again.chatgpt && again.chatgpt !== ran.chatgpt);
  assert.ok((await wiring("person")).includes(`login ${again.chatgpt}.model.login`));
});

test("first run brings what earlier runs made to this build: the same Actors, upgraded", async (t) => {
  const { app, person, actors, wiring } = await setup(t);
  const connected = (id: string) => app.hub.connected(id);
  const before = await firstRun(person, { bundled: await earlierBundle(t), connected });
  assert.ok(before.installer && before.chatgpt && before.packages.assistant);
  // An agent on the earlier assistant build, with its store, and an Actor on another package.
  const { actorId: agent } = (await person.call("actors", "create", {
    name: "John",
    package: before.packages.assistant,
    bindings: [{ slot: "logic.store", provider: "storage", export: "kv" }],
  })) as { actorId: string };
  const { actorId: board } = (await person.call("actors", "create", {
    name: "Board",
    package: before.packages.board,
  })) as { actorId: string };

  const made = (await actors()).length;
  const lines: string[] = [];
  const after = await firstRun(person, { connected, log: (line) => lines.push(line) });
  // The same Actors, each on this build's package.
  assert.equal(after.installer, before.installer);
  assert.equal(after.chatgpt, before.chatgpt);
  const packageOf = async (id: string) =>
    ((await person.call("actors", "get", { actorId: id })) as { package: string }).package;
  assert.equal(await packageOf(before.installer), after.packages.installer);
  assert.equal(await packageOf(before.chatgpt), after.packages.chatgpt);
  assert.equal(await packageOf(agent), after.packages.assistant);
  assert.notEqual(after.packages.assistant, before.packages.assistant);
  assert.equal(await packageOf(board), before.packages.board);
  // Their bindings, and the person's, are there; no Actor was made.
  assert.ok((await wiring(agent)).includes("logic.store storage.kv"));
  assert.ok((await wiring("person")).includes(`installer ${before.installer}.installer.installer`));
  assert.equal((await actors()).length, made);
  for (const what of ["the installer", "ChatGPT", "the agent John"])
    assert.ok(
      lines.some((line) => line.startsWith(`First run: upgraded ${what} (`)),
      `${what}: ${lines.join(" | ")}`,
    );
  // Run again: nothing more to upgrade.
  const quiet: string[] = [];
  await firstRun(person, { connected, log: (line) => quiet.push(line) });
  assert.deepEqual(
    quiet.filter((line) => line.includes("upgraded")),
    [],
  );
});

test("the app runs the first run at start, unless told not to", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-first-run-"));
  const app = await startApp({ home });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  });
  const ran = await app.firstRun;
  assert.ok(ran?.installer && ran.chatgpt);
  const { app: off } = await setup(t);
  assert.equal(off.firstRun, undefined);
});

test("/oauth/chatgpt completes the sign-in through the person's login, and keeps the code out of the tab", async (t) => {
  const { app, person } = await setup(t);
  const completed: string[] = [];
  let refuse: string | undefined;
  const made = (await person.call("actors", "create", { name: "chatgpt" })) as {
    actorId: string;
    credential: string;
  };
  const model = await connect({
    hubUrl: app.hubUrl,
    actorId: made.actorId,
    credential: made.credential,
    exports: { login: accountLogin },
    start(ctx) {
      ctx.exports.login.implement({
        status: () => ({ state: "signed_out" }),
        start: () => ({ authorizeUrl: "https://auth.example/" }),
        complete: ({ callbackUrl }) => {
          completed.push(callbackUrl);
          if (refuse) throw new Refused(refuse as "denied", "No.");
          return { account: {} };
        },
        logout: () => ({ revoked: true }),
      });
    },
  });
  t.after(() => model.close());
  await person.call("grants", "bind", {
    consumer: "person",
    slot: "login",
    provider: made.actorId,
    export: "login",
  });

  const callback = "/oauth/chatgpt?code=SECRET-CODE&state=s1";
  /** The callback, then where it sends the tab: an address without the code. */
  const back = async () => {
    const sent = await get(app, callback);
    assert.equal(sent.status, 303);
    const location = String(sent.headers.location);
    assert.doesNotMatch(location + sent.body, /SECRET-CODE|state=/);
    assert.equal(sent.headers["referrer-policy"], "no-referrer");
    return get(app, location);
  };
  const done = await back();
  assert.equal(done.status, 200);
  assert.match(done.body, /Signed in to ChatGPT/);
  assert.doesNotMatch(done.body, /SECRET-CODE/);
  assert.equal(done.headers["referrer-policy"], "no-referrer");
  assert.equal(done.headers["cache-control"], "no-store");
  // The whole address it came back to, as the login compares it with the redirect.
  assert.deepEqual(completed, [`${app.url}${callback}`]);

  for (const [code, says] of [
    ["denied", /You declined/],
    ["expired", /expired/],
    ["failed", /didn't work/],
  ] as const) {
    refuse = code;
    const refused = await back();
    assert.equal(refused.status, 400);
    assert.match(refused.body, says);
    assert.doesNotMatch(refused.body, /SECRET-CODE|No\./);
  }
  assert.equal((await get(app, callback, "POST")).status, 405);
  // An outcome page made up by hand says only what it says; it completes nothing.
  assert.match((await get(app, "/oauth/chatgpt?result=bogus")).body, /didn't work/);
  assert.equal(completed.length, 4);
});

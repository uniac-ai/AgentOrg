import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage } from "@agentorg/sdk/build";
import { readTar, writeTar } from "@agentorg/sdk/manifest";
import WebSocket from "ws";
import {
  type App,
  readSystem,
  type SystemComposition,
  startApp,
  writeSystem,
} from "../src/index.ts";

// dist/test/transfer.test.js → the repository root.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const MANAGEMENT = ["packages", "actors", "grants", "exports", "bindings"];

/** An app in a temporary home, and the CLI's way in: calls through `/api`, and a bearer. */
async function setup(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "agentorg-transfer-"));
  const app = await startApp({ home, firstRun: false });
  const token = readFileSync(join(home, "cli-token"), "utf8").trim();
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise((done) => socket.once("open", done));
  let id = 0;
  const waiting = new Map<
    number,
    (reply: { result?: unknown; error?: { code?: string } }) => void
  >();
  socket.on("message", (data) => {
    const reply = JSON.parse(String(data));
    waiting.get(reply.id)?.(reply);
  });
  const call = <T>(slot: string, method: string, input: unknown = {}) =>
    new Promise<T>((done, failed) => {
      const n = ++id;
      waiting.set(n, (reply) =>
        reply.error ? failed(new Error(JSON.stringify(reply.error))) : done(reply.result as T),
      );
      socket.send(JSON.stringify({ id: n, op: "call", slot, method, input }));
    });
  t.after(async () => {
    socket.close();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  });
  const bearer = { Authorization: `Bearer ${token}` };
  return { app, home, call, bearer };
}

/** A package built into a temporary folder: its archive's path, bytes and hash. */
async function built(t: test.TestContext, dir: string) {
  const out = mkdtempSync(join(tmpdir(), "agentorg-built-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const result = await buildPackage(dir, { out });
  return { file: result.file, hash: result.hash, bytes: new Uint8Array(readFileSync(result.file)) };
}

const until = async (condition: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (let waited = 0; !(await condition()); waited += 50) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("a package goes up and comes back as the same archive, for the person's UIs only", async (t) => {
  const { app, bearer } = await setup(t);
  const board = await built(t, join(root, "examples", "board"));
  // No bearer, or another: nothing either way.
  for (const headers of [{}, { Authorization: "Bearer nope" }] as Record<string, string>[]) {
    assert.equal(
      (
        await fetch(`${app.url}/packages`, {
          method: "POST",
          headers,
          body: board.bytes as BodyInit,
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(`${app.url}/packages/${board.hash}.agentorg`, { headers })).status,
      401,
    );
  }
  const up = await fetch(`${app.url}/packages`, {
    method: "POST",
    headers: bearer,
    body: board.bytes as BodyInit,
  });
  assert.equal(up.status, 200);
  assert.equal(((await up.json()) as { hash: string }).hash, board.hash);
  const down = await fetch(`${app.url}/packages/${board.hash}.agentorg`, { headers: bearer });
  assert.equal(down.status, 200);
  assert.equal(
    down.headers.get("content-disposition"),
    'attachment; filename="board-0.1.0.agentorg"',
  );
  // Rebuilt from the stored tree: the very bytes the build wrote.
  assert.deepEqual(new Uint8Array(await down.arrayBuffer()), board.bytes);
  const missing = `sha256-${"0".repeat(64)}`;
  assert.equal(
    (await fetch(`${app.url}/packages/${missing}.agentorg`, { headers: bearer })).status,
    400,
  );
  // Not a package: refused, and the reason given.
  const junk = await fetch(`${app.url}/packages`, {
    method: "POST",
    headers: bearer,
    body: "junk",
  });
  assert.equal(junk.status, 400);
  assert.equal(((await junk.json()) as { error: { code: string } }).error.code, "invalid");
});

test("a system file holds exactly composition.json and packages by hash", () => {
  const composition: SystemComposition = {
    format: "agentorg.system/1",
    actors: {},
    connections: [],
    layout: { home: [] },
  };
  const hash = `sha256-${"a".repeat(64)}`;
  const file = writeSystem(composition, new Map([[hash, new Uint8Array([1, 2])]]));
  assert.deepEqual([...readTar(file).keys()], ["composition.json", `packages/${hash}.agentorg`]);
  assert.deepEqual(readSystem(file).composition, composition);
  const json = new TextEncoder().encode(JSON.stringify(composition));
  for (const [what, files] of [
    [
      "another entry",
      new Map([
        ["composition.json", json],
        ["notes.txt", new Uint8Array()],
      ]),
    ],
    [
      "a package by another name",
      new Map([
        ["composition.json", json],
        ["packages/board.agentorg", new Uint8Array()],
      ]),
    ],
    [
      "a nested path",
      new Map([
        ["composition.json", json],
        [`packages/x/${hash}.agentorg`, new Uint8Array()],
      ]),
    ],
    ["no composition", new Map([[`packages/${hash}.agentorg`, new Uint8Array()]])],
    [
      "a composition that isn't JSON",
      new Map([["composition.json", new TextEncoder().encode("{")]]),
    ],
    [
      "a composition of another shape",
      new Map([["composition.json", new TextEncoder().encode('{"format":"x"}')]]),
    ],
  ] as const)
    assert.throws(
      () => readSystem(writeTar(files as Map<string, Uint8Array>)),
      /invalid|isn't|holds no|has a|doesn't fit/i,
      what,
    );
  // A tar with a link, or a path that climbs out, is no system file either.
  const link = writeTar(new Map([["composition.json", json]]));
  link[156] = "2".charCodeAt(0);
  assert.throws(() => readSystem(link), /isn't a system file/);
});

/** The person's installer, made as the app's first run will: bound, then started. */
async function installer(
  t: test.TestContext,
  call: Awaited<ReturnType<typeof setup>>["call"],
  app: App,
) {
  const pkg = await built(t, join(root, "packages", "installer"));
  const { hash } = await call<{ hash: string }>("packages", "add", { path: pkg.file });
  const { actorId } = await call<{ actorId: string }>("actors", "create", {
    name: "installer",
    package: hash,
    bindings: [
      ...MANAGEMENT.map((name) => ({ slot: `installer.${name}`, provider: "hub", export: name })),
      { slot: "installer.storage", provider: "storage", export: "admin" },
      { slot: "installer.layout", provider: "person", export: "layout" },
    ],
  });
  await call("grants", "bind", {
    consumer: "person",
    slot: "installer",
    provider: actorId,
    export: "installer.installer",
  });
  await call("actors", "start", { actorId });
  await until(() => app.hub.connected(actorId));
}

test("a system exports to a file and imports into another home: its Actors, connections and layout", async (t) => {
  const a = await setup(t);
  await installer(t, a.call, a.app);
  const board = await built(t, join(root, "examples", "board"));
  await a.call("packages", "add", { path: board.file });
  const { actorId } = await a.call<{ actorId: string }>("installer", "install", {
    package: board.hash,
    name: "Board",
    connections: { "logic.store": { actor: "storage", export: "kv" } },
    start: true,
  });
  await a.call("layout", "place", { actor: actorId, module: "panel", title: "Launch" });
  assert.equal((await fetch(`${a.app.url}/system`)).status, 401);
  const exported = await fetch(`${a.app.url}/system`, { headers: a.bearer });
  assert.equal(exported.status, 200);
  const file = new Uint8Array(await exported.arrayBuffer());
  const { composition, packages } = readSystem(file);
  assert.deepEqual(Object.keys(composition.actors), ["Board"]);
  assert.deepEqual([...packages.keys()], [board.hash]);

  const b = await setup(t);
  await installer(t, b.call, b.app);
  const imported = await fetch(`${b.app.url}/system`, {
    method: "POST",
    headers: b.bearer,
    body: file as BodyInit,
  });
  assert.equal(imported.status, 200, await imported.clone().text());
  const result = (await imported.json()) as {
    created: Record<string, string>;
    ungranted: unknown[];
  };
  assert.deepEqual(Object.keys(result.created), ["Board"]);
  assert.deepEqual(result.ungranted, []);
  const made = await b.call<{ package: string; state: string }>("actors", "get", {
    actorId: result.created.Board,
  });
  assert.equal(made.package, board.hash);
  const { home } = await b.call<{ home: { actor: string; title?: string }[] }>("layout", "get");
  assert.deepEqual(
    home.map((p) => [p.actor, p.title]),
    [[result.created.Board, "Launch"]],
  );
});

test("an imported package whose hash isn't its name is refused, and nothing is imported", async (t) => {
  const { app, call, bearer } = await setup(t);
  await installer(t, call, app);
  const board = await built(t, join(root, "examples", "board"));
  const wrong = `sha256-${"b".repeat(64)}`;
  const composition = {
    format: "agentorg.system/1" as const,
    actors: { Board: { package: `board@0.1.0#${wrong}` } },
    connections: [],
    layout: { home: [] },
  };
  const file = writeSystem(composition, new Map([[wrong, board.bytes]]));
  const response = await fetch(`${app.url}/system`, {
    method: "POST",
    headers: bearer,
    body: file as BodyInit,
  });
  assert.equal(response.status, 400);
  const { actors } = await call<{ actors: { name: string }[] }>("actors", "list");
  assert.equal(
    actors.some((actor) => actor.name === "Board"),
    false,
  );
});

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Hub, listen, PERSON } from "@agentorg/hub";
import { tools } from "@agentorg/interfaces";
import { connect } from "@agentorg/sdk/client";
import { Connection, type Groups } from "../src/connection.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const GROUPS: Groups = { meta: "test/group", stop: "test/group/stop" };
const until = async (condition: () => boolean) => {
  for (let waited = 0; !condition(); waited += 20) {
    if (waited > 20_000) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A connection to the server in `fixture`, with `groups` or none, and its tools as a caller has them. */
async function connected(t: test.TestContext, fixture: string, groups?: Groups) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-mcp-groups-")));
  const hub = Hub.open(join(root, "home"));
  const server = await listen(hub);
  const leaving: (() => unknown)[] = [];
  t.after(async () => {
    for (const leave of leaving.reverse()) await leave();
    await server.close();
    hub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const warned: string[] = [];
  const log = { info() {}, warn: (message: string) => void warned.push(message), error() {} };
  const served = hub.state.createActor(PERSON, { name: "Server" });
  const connection = new Connection(
    { kind: "command", command: process.execPath, args: [join(fixtures, fixture)] },
    {},
    log,
    {},
    [],
    groups,
  );
  leaving.push(() => connection.end());
  await connection.join({ hubUrl: server.url, ...served });
  connection.run();
  const user = hub.state.createActor(PERSON, {
    name: "User",
    bindings: [{ slot: "tools", provider: served.actorId, export: "tools" }],
  });
  const client = await connect({ hubUrl: server.url, ...user, slots: { tools } });
  leaving.push(() => client.close());
  await until(() => client.slots.tools.bound && connection.status().state === "connected");
  const call = client.slots.tools.call;
  /** What a call of `meta` carried, made under `group` or none. */
  const meta = async (group?: string) =>
    JSON.parse(
      (await call.call({ name: "meta", arguments: {}, ...(group ? { group } : {}) })).output,
    ) as Record<string, unknown>;
  const stopped = async () =>
    JSON.parse((await call.call({ name: "stopped", arguments: {} })).output) as string[];
  return { call, meta, stopped, warned };
}

test("a call's group goes to a server that names groups, and a group's stop is asked of it", async (t) => {
  const { call, meta, stopped } = await connected(t, "groups.js", GROUPS);
  assert.equal((await meta("turn-1"))["test/group"], "turn-1");
  assert.equal((await meta())["test/group"], undefined);
  assert.deepEqual(await call.stop({ group: "turn-1" }), {});
  assert.deepEqual(await stopped(), ["turn-1"]);
});

test("a connection made with no names for groups passes no group on, and its stop asks nothing", async (t) => {
  const { call, meta, stopped } = await connected(t, "groups.js");
  assert.equal((await meta("turn-1"))["test/group"], undefined);
  assert.deepEqual(await call.stop({ group: "turn-1" }), {});
  assert.deepEqual(await stopped(), []);
});

test("a server with no stop request has nothing to end; a stop that fails is said in the log", async (t) => {
  const said = (warned: string[]) =>
    warned.filter((line) => line.startsWith("A group's stop wasn't taken")).length;
  const plain = await connected(t, "server.js", GROUPS);
  assert.deepEqual(await plain.call.stop({ group: "turn-1" }), {});
  assert.equal(said(plain.warned), 0);
  // The connection is as it was.
  assert.deepEqual(await plain.call.call({ name: "echo", arguments: { text: "hi" } }), {
    output: "hi",
  });
  const failing = await connected(t, "groups.js", GROUPS);
  assert.deepEqual(await failing.call.stop({ group: "fails" }), {});
  assert.equal(said(failing.warned), 1);
});

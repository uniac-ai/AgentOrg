import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hubActors, hubGrants } from "@agentorg/interfaces";
import { defineInterface, describeInterface, method, Refused } from "@agentorg/sdk";
import { buildPackage } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { Hub, HubState, listen, PERSON, STORAGE } from "../src/index.ts";
import { counter } from "./fixtures/seeded/src/interface.ts";

// dist/test/upgrade.test.js → this package's folder and its seeded counter fixture.
const hubFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const seeded = join(hubFolder, "test", "fixtures", "seeded");
const refused = (code: string, text?: RegExp) => (error: unknown) =>
  error instanceof Refused && error.code === code && (!text || text.test(error.message));
const until = async (condition: () => boolean, ms = 15_000) => {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The seeded counter, built as it is or with its logic or its interface changed. */
async function build(t: test.TestContext, change: { step?: number; reset?: boolean } = {}) {
  const dir = join(hubFolder, ".test-fixtures", `upgrade-${randomUUID()}`);
  cpSync(seeded, dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (change.step !== undefined) {
    const logic = join(dir, "src", "counter.ts");
    writeFileSync(
      logic,
      readFileSync(logic, "utf8").replace(
        '(typeof value === "number" ? value : 0) + 1',
        `(typeof value === "number" ? value : 0) + ${change.step}`,
      ),
    );
  }
  if (change.reset) {
    const iface = join(dir, "src", "interface.ts");
    writeFileSync(
      iface,
      readFileSync(iface, "utf8").replace(
        "increment: method(",
        "reset: method({ input: z.object({}), output: z.object({}) }),\n    increment: method(",
      ),
    );
  }
  return (await buildPackage(dir, { out: join(dir, "out") })).file;
}

function open(t: test.TestContext) {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-upgrade-")), "home");
  t.after(() => rmSync(dirname(home), { recursive: true, force: true }));
  const state = HubState.open(home);
  t.after(() => state.close());
  return state;
}

const notes = (min: number) =>
  describeInterface(
    defineInterface({
      name: "notes",
      major: 1,
      kind: "rpc",
      methods: {
        write: method({ input: z.object({ text: z.string().min(min) }), output: z.object({}) }),
      },
    }),
  );

test("a binding holds while both ends declare the same interface: redeclared as another, it is dropped", (t) => {
  const state = open(t);
  const make = (name: string) => state.createActor(PERSON, { name }).actorId;
  const provider = make("Provider");
  const consumer = make("Consumer");
  state.declareExternal(provider, { slots: {}, exports: { notes: notes(1) } });
  state.declareExternal(consumer, { slots: { notes: notes(1) }, exports: {} });
  const wiring = { consumer, slot: "notes", provider, export: "notes" };
  state.bind(PERSON, wiring);
  // The same interface again keeps it.
  state.declareExternal(consumer, { slots: { notes: notes(1) }, exports: {} });
  assert.ok(state.binding(consumer, "notes"));
  // The slot redeclared as another interface: the binding goes, audited; nothing is refused.
  state.declareExternal(consumer, { slots: { notes: notes(2) }, exports: {} });
  assert.equal(state.binding(consumer, "notes"), undefined);
  assert.deepEqual(state.declaration(consumer, "slot", "notes")?.iface, notes(2));
  // Bound again, then the export redeclared as another: the same.
  state.declareExternal(provider, { slots: {}, exports: { notes: notes(2) } });
  state.bind(PERSON, wiring);
  state.declareExternal(provider, { slots: {}, exports: { notes: notes(3) } });
  assert.equal(state.binding(consumer, "notes"), undefined);
  const drops = state
    .audit(0, 1000)
    .entries.filter((e) => e.kind === "binding.drop")
    .map((e) => [e.actor, e.details.consumer, e.details.slot]);
  assert.deepEqual(drops, [
    [consumer, consumer, "notes"],
    [provider, consumer, "notes"],
  ]);
});

test("upgrade keeps the Actor, its store and the bindings that still match, and drops the rest", async (t) => {
  const state = open(t);
  const add = async (file: string) => state.addPackage(PERSON, file).hash;
  const v1 = await add(await build(t));
  const faster = await add(await build(t, { step: 10 }));
  const another = await add(await build(t, { reset: true }));
  const { actorId } = state.createActor(PERSON, {
    name: "Counter",
    package: v1,
    bindings: [{ slot: "counter.store", provider: STORAGE, export: "kv" }],
  });
  const { actorId: user } = state.createActor(PERSON, { name: "User" });
  const offered = state.declaration(actorId, "export", "counter.counter")?.iface;
  assert.ok(offered);
  state.declareExternal(user, { slots: { counter: offered }, exports: {} });
  const use = { consumer: user, slot: "counter", provider: actorId, export: "counter.counter" };
  state.bind(PERSON, use);

  // The same interfaces: nothing is dropped, the Actor is the same one on the new package.
  assert.deepEqual(state.upgrade(PERSON, actorId, faster), []);
  assert.equal(state.actor(actorId).package, faster);
  assert.ok(state.binding(user, "counter"));
  assert.ok(state.binding(actorId, "counter.store"));
  // Its export declared as another interface: the user's binding is dropped and returned; the
  // store's, whose interface is unchanged, stays.
  assert.deepEqual(state.upgrade(PERSON, actorId, another), [use]);
  assert.equal(state.binding(user, "counter"), undefined);
  assert.equal(state.binding(actorId, "counter.store")?.provider, STORAGE);
  assert.notDeepEqual(state.declaration(actorId, "export", "counter.counter")?.iface, offered);
  const upgrades = state.audit(0, 1000).entries.filter((e) => e.kind === "actor.upgrade");
  assert.deepEqual(
    upgrades.map((e) => [e.details.from, e.details.to, (e.details.dropped as unknown[]).length]),
    [
      [v1, faster, 0],
      [faster, another, 1],
    ],
  );
  // The package it already runs: nothing to do.
  assert.deepEqual(state.upgrade(PERSON, actorId, another), []);
});

test("only a package Actor that isn't closed is upgraded, by whoever may close it, to a package here", async (t) => {
  const state = open(t);
  const v1 = state.addPackage(PERSON, await build(t)).hash;
  const { actorId } = state.createActor(PERSON, { name: "Counter", package: v1 });
  const { actorId: external } = state.createActor(PERSON, { name: "External" });
  assert.throws(() => state.upgrade(PERSON, "storage", v1), refused("forbidden", /built in/));
  assert.throws(
    () => state.upgrade(PERSON, external, v1),
    refused("state", /isn't a package Actor/),
  );
  assert.throws(
    () => state.upgrade(PERSON, actorId, `sha256-${"0".repeat(64)}`),
    refused("unknown"),
  );
  // An Actor that can't close it can't upgrade it.
  assert.throws(() => state.upgrade(external, actorId, v1), refused("forbidden"));
  state.closeActor(PERSON, actorId);
  assert.throws(() => state.upgrade(PERSON, actorId, v1), refused("state", /closed/));
});

test("a running Actor upgraded restarts on the new package, with its store", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-upgrade-run-")));
  const home = join(dir, "home");
  const hub = Hub.open(home);
  const server = await listen(hub);
  const open: { close(): void }[] = [];
  t.after(async () => {
    for (const client of open) client.close();
    await server.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, grants: hubGrants },
    declare: false,
  });
  open.push(person);
  const v1 = hub.state.addPackage(PERSON, await build(t)).hash;
  const faster = hub.state.addPackage(PERSON, await build(t, { step: 10 })).hash;
  const { actorId } = await person.slots.actors.call.create({
    name: "Counter",
    package: v1,
    bindings: [{ slot: "counter.store", provider: STORAGE, export: "kv" }],
  });
  await person.slots.actors.call.start({ actorId });
  await until(() => hub.connected(actorId));
  const made = hub.state.createActor(PERSON, {
    name: "User",
    bindings: [{ slot: "counter", provider: actorId, export: "counter.counter" }],
  });
  const user = await connect({
    hubUrl: server.url,
    actorId: made.actorId,
    credential: made.credential as string,
    slots: { counter },
  });
  open.push(user);
  await until(() => user.slots.counter.bound);
  assert.deepEqual(await user.slots.counter.call.increment({}), { value: 1 });

  assert.deepEqual(await person.slots.actors.call.upgrade({ actorId, package: faster }), {
    dropped: [],
  });
  await until(() => hub.connected(actorId));
  const record = await person.slots.actors.call.get({ actorId });
  assert.equal(record.package, faster);
  assert.equal(record.state, "running");
  // The new build counts by ten, from what the old one stored.
  for (let i = 0; i < 300; i++) {
    const got = await user.slots.counter.call.increment({}).catch(() => undefined);
    if (got) {
      assert.deepEqual(got, { value: 11 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("the upgraded Actor never answered");
});

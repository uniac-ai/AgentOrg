import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { hubActors, hubGrants, kv, storageAdmin } from "@agentorg/interfaces";
import type { Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { Hub, listen, PERSON, STORAGE } from "../src/index.ts";

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 3000) => {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > ms) throw new Error("timed out waiting");
    await later(5);
  }
};

async function setup(t: test.TestContext) {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-storage-")), "home");
  const hub = Hub.open(home, { storage: { maxValue: 1024, maxPerConsumer: 4096 } });
  const server = await listen(hub);
  const open: { close(): void }[] = [];
  t.after(async () => {
    for (const client of open) client.close();
    await server.close();
    hub.close();
    rmSync(join(home, ".."), { recursive: true, force: true });
  });
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, grants: hubGrants },
    declare: false,
  });
  open.push(person);
  /** An external Actor with two kv slots, both bound to storage. */
  const consumer = async (name: string) => {
    const made = await person.slots.actors.call.create({
      name,
      bindings: [
        { slot: "a", provider: STORAGE, export: "kv" },
        { slot: "b", provider: STORAGE, export: "kv" },
      ],
    });
    const client = await connect({
      hubUrl: server.url,
      actorId: made.actorId,
      credential: made.credential as string,
      slots: { a: kv, b: kv },
    });
    open.push(client);
    await until(() => client.slots.a.bound && client.slots.b.bound);
    return { id: made.actorId, client };
  };
  return { hub, home, person, consumer, url: server.url };
}

test("one store per consumer slot, apart from every other consumer's", async (t) => {
  const { home, consumer } = await setup(t);
  const one = await consumer("one");
  const two = await consumer("two");
  await one.client.slots.a.call.set({ key: "k", value: { n: 1 } });
  await one.client.slots.b.call.set({ key: "k", value: "b's" });
  await two.client.slots.a.call.set({ key: "k", value: null });
  assert.deepEqual(await one.client.slots.a.call.get({ key: "k" }), { value: { n: 1 } });
  assert.deepEqual(await one.client.slots.b.call.get({ key: "k" }), { value: "b's" });
  assert.deepEqual(
    await two.client.slots.a.call.get({ key: "k" }),
    { value: null },
    "a stored null",
  );
  assert.deepEqual(await two.client.slots.b.call.get({ key: "k" }), {}, "absent");
  assert.deepEqual(await one.client.slots.a.call.delete({ key: "k" }), { deleted: true });
  assert.deepEqual(await one.client.slots.a.call.delete({ key: "k" }), { deleted: false });
  assert.equal(statSync(join(home, "storage.db")).mode & 0o777, 0o600);
});

test("list by prefix, in order, a page at a time", async (t) => {
  const { consumer } = await setup(t);
  const { client } = await consumer("lister");
  for (const key of ["card/3", "card/1", "card/2", "note/1", "cardinal"])
    await client.slots.a.call.set({ key, value: key });
  const first = await client.slots.a.call.list({ prefix: "card/", limit: 2 });
  assert.deepEqual(first, { keys: ["card/1", "card/2"], next: "card/2" });
  const rest = await client.slots.a.call.list({
    prefix: "card/",
    after: first.next ?? "",
    limit: 2,
  });
  assert.deepEqual(rest, { keys: ["card/3"], next: null });
  assert.deepEqual((await client.slots.a.call.list({})).keys, [
    "card/1",
    "card/2",
    "card/3",
    "cardinal",
    "note/1",
  ]);
});

test("values and a consumer's stores are bounded: quota", async (t) => {
  const { consumer } = await setup(t);
  const { client } = await consumer("hoarder");
  await assert.rejects(
    client.slots.a.call.set({ key: "big", value: "x".repeat(2000) }),
    (e: Refused) => e.code === "quota",
  );
  // 4096 bytes across both slots: three ~1000-byte values fit, a fifth across slots doesn't.
  for (const key of ["1", "2", "3"]) await client.slots.a.call.set({ key, value: "y".repeat(990) });
  await client.slots.b.call.set({ key: "4", value: "y".repeat(990) });
  await assert.rejects(
    client.slots.b.call.set({ key: "5", value: "y".repeat(990) }),
    (e: Refused) => e.code === "quota",
  );
  // Replacing a value counts only the difference.
  await client.slots.a.call.set({ key: "1", value: "z".repeat(990) });
});

test("stores outlive an unbind, and go when their Actor is closed", async (t) => {
  const { person, consumer, home } = await setup(t);
  const { id, client } = await consumer("keeper");
  await client.slots.a.call.set({ key: "k", value: "kept" });
  await person.slots.grants.call.unbind({ consumer: id, slot: "a" });
  await until(() => !client.slots.a.bound);
  await person.slots.grants.call.bind({ consumer: id, slot: "a", provider: STORAGE, export: "kv" });
  await until(() => client.slots.a.bound);
  assert.deepEqual(await client.slots.a.call.get({ key: "k" }), { value: "kept" });

  await person.slots.actors.call.close({ actorId: id });
  const db = new DatabaseSync(join(home, "storage.db"));
  const rows = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM store WHERE consumer = ?").get(id) as { n: number }).n;
  await until(() => rows() === 0);
  db.close();
  // A new Actor gets a new id, so nothing could reach the old store; the rows themselves are gone.
  const fresh = await consumer("fresh");
  assert.deepEqual(await fresh.client.slots.a.call.get({ key: "k" }), {});
  await assert.rejects(
    person.slots.actors.call.close({ actorId: STORAGE }),
    (e: Refused) => e.code === "forbidden",
  );
});

test("a closed Actor's stores that couldn't be deleted at once go when the Hub opens again", async (t) => {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-storage-")), "home");
  t.after(() => rmSync(join(home, ".."), { recursive: true, force: true }));
  let hub = Hub.open(home);
  const made = hub.state.createActor(PERSON, {
    name: "gone",
    bindings: [{ slot: "a", provider: STORAGE, export: "kv" }],
  });
  // Rows written directly, as a store would have been.
  hub.close();
  const db = new DatabaseSync(join(home, "storage.db"));
  db.exec(
    `INSERT INTO store VALUES ('${made.actorId}', 'a', 'k', '"v"', 4);
     INSERT INTO usage VALUES ('${made.actorId}', 4);`,
  );
  db.close();
  hub = Hub.open(home);
  hub.state.closeActor(PERSON, made.actorId);
  hub.close();
  const check = new DatabaseSync(join(home, "storage.db"));
  const count = () => (check.prepare("SELECT COUNT(*) AS n FROM store").get() as { n: number }).n;
  assert.equal(count(), 0, "deleted on close");
  check.exec(`INSERT INTO store VALUES ('${made.actorId}', 'a', 'k', '"v"', 4);
    INSERT INTO usage VALUES ('${made.actorId}', 4);`);
  hub = Hub.open(home);
  hub.close();
  assert.equal(count(), 0, "and swept when the Hub opens, if they were left");
  check.close();
});

test("keys are at most 1 KiB as UTF-8", async (t) => {
  const { consumer } = await setup(t);
  const { client } = await consumer("keys");
  await assert.rejects(
    client.slots.a.call.set({ key: "😀".repeat(300), value: 1 }),
    (e: Refused) => e.code === "quota",
  );
  await client.slots.a.call.set({ key: "k".repeat(1024), value: 1 });
});

test("a storage that can't open leaves the home unlocked for the next try", (t) => {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-storage-")), "home");
  t.after(() => rmSync(join(home, ".."), { recursive: true, force: true }));
  Hub.open(home).close();
  rmSync(join(home, "storage.db"));
  mkdirSync(join(home, "storage.db"));
  assert.throws(() => Hub.open(home), /database|directory/i);
  rmSync(join(home, "storage.db"), { recursive: true });
  const again = Hub.open(home);
  again.close();
});

test("storage.admin seeds an empty store, all or none, within the limits, and audits it", async (t) => {
  const { hub, person, consumer, url } = await setup(t);
  const target = await consumer("target");
  // The installer's stand-in: an Actor bound to storage's admin export.
  const made = await person.slots.actors.call.create({
    name: "installer",
    bindings: [{ slot: "storage", provider: STORAGE, export: "admin" }],
  });
  const installer = await connect({
    hubUrl: url,
    actorId: made.actorId,
    credential: made.credential as string,
    slots: { storage: storageAdmin },
  });
  t.after(() => installer.close());
  await until(() => installer.slots.storage.bound);
  const seed = (slot: string, entries: { key: string; value: unknown }[], who = target.id) =>
    installer.slots.storage.call.seed({ consumer: who, slot, entries: entries as never });

  await seed("a", [
    { key: "count", value: 3 },
    { key: "title", value: "seeded" },
  ]);
  assert.deepEqual(await target.client.slots.a.call.get({ key: "count" }), { value: 3 });
  assert.deepEqual(await target.client.slots.a.call.list({}), {
    keys: ["count", "title"],
    next: null,
  });
  // Not empty any more: refused, and nothing changes.
  await assert.rejects(
    seed("a", [{ key: "count", value: 9 }]),
    (e: Refused) => e.code === "not_empty",
  );
  assert.deepEqual(await target.client.slots.a.call.get({ key: "count" }), { value: 3 });
  // Emptied, it can be seeded again.
  await target.client.slots.a.call.delete({ key: "count" });
  await target.client.slots.a.call.delete({ key: "title" });
  await seed("a", [{ key: "count", value: 1 }]);

  // All or none: a value past the limit, a key given twice, or past the consumer's quota.
  const refused = async (entries: { key: string; value: unknown }[], code: string) => {
    await assert.rejects(seed("b", entries), (e: Refused) => e.code === code, code);
    assert.deepEqual(await target.client.slots.b.call.list({}), { keys: [], next: null });
  };
  await refused(
    [
      { key: "ok", value: 1 },
      { key: "big", value: "x".repeat(2000) },
    ],
    "quota",
  );
  await refused(
    [
      { key: "k", value: 1 },
      { key: "k", value: 2 },
    ],
    "invalid",
  );
  await refused(
    Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, value: "y".repeat(900) })),
    "quota",
  );
  // A consumer that isn't there, or is closed.
  await assert.rejects(seed("a", [], "act_nobody"), (e: Refused) => e.code === "unknown");
  const gone = await consumer("gone");
  await person.slots.actors.call.close({ actorId: gone.id });
  await assert.rejects(
    seed("a", [{ key: "k", value: 1 }], gone.id),
    (e: Refused) => e.code === "state",
  );

  const audited = hub.state
    .audit(0, 1000)
    .entries.filter((e) => e.kind === "storage.seed")
    .map((e) => [e.actor, e.details]);
  assert.deepEqual(audited, [
    [made.actorId, { consumer: target.id, slot: "a", entries: 2 }],
    [made.actorId, { consumer: target.id, slot: "a", entries: 1 }],
  ]);
});

test("a seed counts toward its Actor's quota, reaches only its kv slots, and takes only well-formed keys", async (t) => {
  const { hub, person, consumer, url } = await setup(t);
  const target = await consumer("target");
  const made = await person.slots.actors.call.create({
    name: "installer",
    bindings: [{ slot: "storage", provider: STORAGE, export: "admin" }],
  });
  const installer = await connect({
    hubUrl: url,
    actorId: made.actorId,
    credential: made.credential as string,
    slots: { storage: storageAdmin },
  });
  t.after(() => installer.close());
  await until(() => installer.slots.storage.bound);
  const seed = (slot: string, entries: { key: string; value: unknown }[], who = target.id) =>
    installer.slots.storage.call.seed({ consumer: who, slot, entries: entries as never });
  const value = "v".repeat(990);

  // What's already stored counts: this fits alone (about 4 KB of 4 KiB), not beside 1 KB in b.
  await target.client.slots.b.call.set({ key: "held", value });
  const four = Array.from({ length: 4 }, (_, i) => ({ key: `k${i}`, value }));
  await assert.rejects(seed("a", four), (e: Refused) => e.code === "quota");
  await target.client.slots.b.call.delete({ key: "held" });
  // And what a seed stores counts afterwards.
  await seed("a", four);
  await target.client.slots.b.call.set({ key: "one", value: "x" });
  await assert.rejects(
    target.client.slots.b.call.set({ key: "two", value }),
    (e: Refused) => e.code === "quota",
  );
  // Deleted, it no longer counts.
  for (const { key } of four) await target.client.slots.a.call.delete({ key });
  await target.client.slots.b.call.set({ key: "two", value });

  // Only the consumer's own slots bound to storage.kv: not a slot it lacks, not a built-in Actor.
  for (const [who, slot] of [
    [target.id, "nosuch"],
    ["hub", "packages"],
    ["storage", "kv"],
  ] as const)
    await assert.rejects(
      seed(slot, [{ key: "k", value: 1 }], who),
      (e: Refused) => e.code === "invalid",
      `${who}.${slot}`,
    );
  // A key's limit is in UTF-8 bytes; half a surrogate pair isn't a key.
  await assert.rejects(
    seed("a", [{ key: "€".repeat(400), value: 1 }]),
    (e: Refused) => e.code === "quota",
  );
  await assert.rejects(
    seed("a", [{ key: "\ud800", value: 1 }]),
    (e: Refused) => e.code === "invalid",
  );
  await assert.rejects(
    target.client.slots.a.call.set({ key: "\udc00", value: 1 }),
    (e: Refused) => e.code === "invalid",
  );
  assert.equal(hub.state.audit(0, 1000).entries.filter((e) => e.kind === "storage.seed").length, 1);
});

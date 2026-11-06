import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { hubActors, hubGrants, kv } from "@agentorg/interfaces";
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
  return { hub, home, person, consumer };
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

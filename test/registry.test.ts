/** Every Actor on one flat level: the person, handles, stand-ins and closing. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registry } from "../src/domain/registry.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";

const now = () => "2026-10-31T00:00:00.000Z";

function fixture(t: { after(fn: () => void): void }) {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  return { store, actors: registry(store.actors, now) };
}

test("the person is the first Actor the Hub made", async (t) => {
  const { store, actors } = fixture(t);
  assert.equal(actors.root(), undefined);
  const { root } = await actors.createRoot();
  const { actor: lead } = await actors.create("lead", "Lead");
  store.actors.insert({ ...lead, id: "act_later", name: "later", credential_hash: "h" });
  assert.equal(actors.root()?.id, root.id);
});

test("handles are unique among open Actors, and a closed Actor's handle is free again", async (t) => {
  const { actors } = fixture(t);
  const { root } = await actors.createRoot();
  const { actor: storage } = await actors.create("storage", "Storage");
  await assert.rejects(actors.create("storage", "Another"), /already named storage/);
  actors.close(root, storage.id);
  assert.equal((await actors.create("storage", "Another")).actor.name, "storage");
});

test("an open Actor stands for itself, a closed one's stand-in is the person", async (t) => {
  const { actors } = fixture(t);
  const { root } = await actors.createRoot();
  const { actor: lead } = await actors.create("lead", "Lead");
  const { actor: worker } = await actors.create("worker", "Work");
  assert.equal(actors.standIn(worker.id), worker.id);
  actors.close(lead, worker.id);
  assert.equal(actors.standIn(worker.id), root.id);
  assert.equal(actors.standIn(root.id), root.id);
  assert.equal(actors.standIn("missing"), undefined);
});

test("any open Actor closes any other, never the person, and not itself", async (t) => {
  const { actors } = fixture(t);
  const { root } = await actors.createRoot();
  const { actor: lead } = await actors.create("lead", "Lead");
  const { actor: worker } = await actors.create("worker", "Work");
  assert.throws(() => actors.close(lead, root.id), /the person is never closed/);
  assert.throws(() => actors.close(root, root.id), /the person is never closed/);
  assert.throws(() => actors.close(lead, lead.id), /closes others, not itself/);
  // Any open Actor closes another, with or without open Actors beside it.
  const closed = actors.close(worker, lead.id);
  assert.deepEqual([closed.changed, closed.actor.closed_at], [true, now()]);
  assert.equal(actors.close(root, lead.id).changed, false);
  assert.deepEqual(
    actors.open().map((actor) => actor.name),
    ["root", "worker"],
  );
});

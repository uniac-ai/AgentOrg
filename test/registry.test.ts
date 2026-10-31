/** Canonical ancestry uses retained identities rather than open Team traversal. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ActorRow, registry } from "../src/domain/registry.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";

const now = () => "2026-10-31T00:00:00.000Z";

test("inclusive ancestry retains deep, closed positions and rejects unknown or unrelated IDs", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const actors = registry(store.actors, now);
  const { root } = await actors.createRoot();
  const { actor: other } = await actors.create(root.id, "other", "Other branch");
  const chain = [];
  let manager = root.id;
  for (let depth = 0; depth < 25; depth += 1) {
    const { actor } = await actors.create(manager, `report-${depth}`, "Deep position");
    chain.push(actor);
    manager = actor.id;
  }
  const anchor = chain[0];
  const leaf = chain.at(-1);
  assert.ok(anchor);
  assert.ok(leaf);
  assert.equal(actors.within(root.id, root.id), true);
  assert.equal(actors.within(leaf.id, anchor.id), true);
  assert.equal(actors.within(anchor.id, leaf.id), false);
  assert.equal(actors.within(leaf.id, other.id), false);
  assert.equal(actors.within(other.id, anchor.id), false);
  for (const [id, ancestor] of [
    ["missing", root.id],
    [leaf.id, "missing"],
    ["missing", "missing"],
  ] as const)
    assert.equal(actors.within(id, ancestor), false);
  for (const actor of [...chain].reverse()) actors.close(root, actor.id);
  assert.deepEqual(
    actors.reports(root.id).map((actor) => actor.id),
    [other.id],
  );
  assert.equal(actors.found(anchor.id).closed_at, now());
  assert.equal(actors.within(leaf.id, root.id), true);
  assert.equal(actors.within(leaf.id, anchor.id), true);
  assert.equal(actors.within(anchor.id, anchor.id), true);
  assert.equal(actors.within(leaf.id, other.id), false);
});

test("ancestry stops on missing and repeated parents", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const actors = registry(store.actors, now);
  const { root } = await actors.createRoot();
  const { actor: lead } = await actors.create(root.id, "lead", "Lead");
  const { actor: leaf } = await actors.create(lead.id, "leaf", "Leaf");
  const get = store.actors.get;
  const rows = new Map<string, ActorRow>([[leaf.id, { ...leaf, manager: "missing" }]]);
  let reads = 0;
  t.mock.method(store.actors, "get", (id: string) => {
    assert.ok(++reads < 10, "ancestry must terminate on the finite parent chain");
    return rows.get(id) ?? get(id);
  });
  const within = (id: string, ancestor: string) => {
    reads = 0;
    return actors.within(id, ancestor);
  };
  assert.equal(within(leaf.id, root.id), false);
  assert.equal(within(leaf.id, leaf.id), true);
  rows.set(leaf.id, leaf);
  rows.set(lead.id, { ...lead, manager: leaf.id });
  assert.equal(within(leaf.id, root.id), false);
  assert.equal(within(leaf.id, lead.id), true);
  rows.set(leaf.id, { ...leaf, manager: leaf.id });
  assert.equal(within(leaf.id, root.id), false);
});

/** The assembled Hub exposes explicit feature Tools, independently of Actor hierarchy and presence. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { organization } from "../src/domain/index.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";
import { done, HUB_INTERFACES, refused } from "./harness.ts";

const invocation = { signal: new AbortController().signal, progress: async () => {} };

test("all open Actors see exactly the nine Hub Tools and twenty-three interfaces", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const org = organization(store);
  const { root } = await org.registry.createRoot();
  const { actor: lead } = await org.registry.create(root.id, "manager", "Lead");
  const { actor: worker } = await org.registry.create(lead.id, "worker", "Work");
  const catalog = org.available(root.id);
  const grouped = Object.fromEntries(
    catalog.map((tool) => {
      assert.equal(tool.id, `hub:${tool.name}`);
      assert.deepEqual(Object.keys(tool).sort(), ["id", "interfaces", "name"]);
      for (const offer of tool.interfaces) {
        assert.equal(offer.call, offer.interface.name);
        assert.deepEqual(Object.keys(offer).sort(), ["call", "interface", "read_only"]);
      }
      return [tool.name, tool.interfaces.map((offer) => offer.interface.name).sort()];
    }),
  );
  assert.deepEqual(
    grouped,
    Object.fromEntries(
      Object.entries(HUB_INTERFACES).map(([name, names]) => [name, [...names].sort()]),
    ),
  );
  assert.equal(catalog.length, 9);
  assert.equal(catalog.flatMap((tool) => tool.interfaces).length, 23);
  assert.deepEqual(org.available(lead.id), catalog);
  assert.deepEqual(org.available(worker.id), catalog);
  const connection = { close() {} };
  org.online(worker.id, connection);
  assert.deepEqual(org.available(worker.id), catalog);
  for (const id of [root.id, lead.id, worker.id]) {
    for (const alias of [
      "manager.team",
      "worker.progress_set",
      "manager.worker.review",
      `${worker.id}.review`,
    ]) {
      assert.equal(await refused(org.invoke(id, alias, {}, invocation)), "not_found");
    }
  }
  assert.equal(store.database.count("calls", "1"), 0);
  org.offline(worker.id, connection);
  assert.deepEqual(org.available(worker.id), catalog);
});

test("lifecycle authority and leaf closure are checked by the Actors Tool", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const org = organization(store);
  const { root } = await org.registry.createRoot();
  const invoke = (actor: string, name: string, input: Record<string, unknown> = {}) =>
    org.invoke(actor, name, input, invocation);
  const lead = await done(invoke(root.id, "actor_create", { name: "lead", purpose: "Lead" }));
  const worker = await done(
    invoke(lead.actor.id, "actor_create", { name: "worker", purpose: "Work" }),
  );
  const other = await done(invoke(root.id, "actor_create", { name: "other", purpose: "Other" }));
  assert.equal("interfaces" in worker.actor, false);
  assert.equal("created_at_attach" in worker.actor, false);
  assert.equal(
    await refused(
      invoke(root.id, "actor_create", { name: "old", purpose: "Old", created_at_attach: true }),
    ),
    "invalid",
  );
  assert.equal(
    await refused(invoke(other.actor.id, "actor_close", { actor: worker.actor.id })),
    "forbidden",
  );
  assert.equal(await refused(invoke(root.id, "actor_close", { actor: lead.actor.id })), "conflict");
  const closed = await done(invoke(lead.actor.id, "actor_close", { actor: worker.actor.id }));
  assert.deepEqual(Object.keys(closed), ["actor"]);
  assert.ok(closed.actor.closed_at);
  assert.deepEqual(org.available(worker.actor.id), []);
  assert.equal(await refused(invoke(worker.actor.id, "team")), "forbidden");
  await done(invoke(root.id, "actor_close", { actor: lead.actor.id }));
  const team = await done(invoke(root.id, "team", { depth: 5 }));
  for (const position of team.positions) {
    assert.equal("interfaces" in position, false);
    assert.equal("created_at_attach" in position, false);
  }
});

test("an unsupported database schema is refused without changing its records", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-schema-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "core.db");
  const old = new DatabaseSync(path);
  old.exec(
    "PRAGMA user_version = 6; CREATE TABLE kept (value TEXT); INSERT INTO kept VALUES ('kept');",
  );
  old.close();
  assert.throws(() => new SqliteStore(path), /database has schema 6; this agentorg reads 9/);
  const unchanged = new DatabaseSync(path);
  t.after(() => unchanged.close());
  assert.equal(unchanged.prepare("PRAGMA user_version").get()?.user_version, 6);
  assert.equal(unchanged.prepare("SELECT value FROM kept").get()?.value, "kept");
});

test("audit metadata is shared without disclosing message bodies or Actor credentials", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const org = organization(store);
  const { root, credential: rootCredential } = await org.registry.createRoot();
  const { actor, credential } = await org.registry.create(root.id, "worker", "Work");
  const invoke = (id: string, name: string, input: Record<string, unknown> = {}) =>
    org.invoke(id, name, input, invocation);
  const secret = "private-message-body-sentinel";
  await done(invoke(actor.id, "message_send", { recipientID: root.id, text: secret }));
  await done(invoke(actor.id, "work_create", { ownerID: root.id, goal: "Working" }));
  const rootView = await done(invoke(root.id, "activity"));
  const workerView = await done(invoke(actor.id, "activity"));
  assert.deepEqual(workerView, rootView);
  assert.deepEqual(
    rootView.entries.map((entry: { operation: string }) => entry.operation),
    ["work_create", "message_send"],
  );
  for (const entry of rootView.entries)
    assert.deepEqual(Object.keys(entry).sort(), [
      "actor",
      "at",
      "id",
      "operation",
      "outcome",
      "target",
    ]);
  for (const privateValue of [secret, rootCredential, credential])
    assert.equal(JSON.stringify(rootView).includes(privateValue), false);
});

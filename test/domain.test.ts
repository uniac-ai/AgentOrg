/** State owners independently, and the triggers and views assembled over their clients. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { organization } from "../src/domain/index.ts";
import type { Delivery, Outcome } from "../src/domain/model/index.ts";
import type { ActorLink } from "../src/domain/ports.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";
import { iface, until } from "./harness.ts";

const invocation = { cause: null, signal: new AbortController().signal, progress: async () => {} };
const link = (): ActorLink => ({
  deliver: async () => ({ ok: true, value: {}, parts: [] }),
  outcome: async () => ({ ok: true, value: {}, parts: [] }),
  cancel: async () => {},
  close: async () => {},
});

test("delivery and settlement use the latest advertised contract, including changes while a call is in flight", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const org = organization(store, { waitMs: 0 });
  const { root } = await org.registry.createRoot();
  const { actor } = await org.registry.create(root.id, "worker", "Work");
  let finish!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => {
    finish = resolve;
  });
  const received: Delivery[] = [];
  const channel = {
    ...link(),
    deliver: async (delivery: Delivery) => {
      received.push(delivery);
      return outcome;
    },
  };
  const initial = iface("work", {
    output: { type: "object", properties: { result: { type: "string" } } },
  });
  org.begin(actor.id, channel);
  org.online(actor.id, channel, [initial]);
  org.offline(actor.id, channel);
  const answer = await org.invoke(root.id, "worker.work", {}, invocation);
  assert.equal(answer.state, "pending");
  assert.equal(received.length, 0);
  const resumed = { ...channel };
  org.begin(actor.id, resumed);
  org.online(actor.id, resumed, [{ ...initial, long_running: true }]);
  assert.equal(received[0]?.long_running, true);
  org.changed(actor.id, resumed, [
    iface("work", { output: { type: "object", properties: { result: { type: "integer" } } } }),
  ]);
  finish({ ok: true, value: { result: "ready" }, parts: [] });
  assert.ok(answer.state === "pending");
  await until(
    "call fails against the changed output contract",
    () => org.calls.found(answer.call).state === "failed",
  );
  assert.match(org.calls.found(answer.call).error ?? "", /output does not match/);
});

test("a schema mismatch refuses the database without migrating or deleting its records", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-schema-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "core.db");
  const old = new DatabaseSync(file);
  old.exec(
    "PRAGMA user_version = 6; CREATE TABLE kept (value TEXT); INSERT INTO kept VALUES ('kept');",
  );
  old.close();
  assert.throws(() => new SqliteStore(file), /database has schema 6; this agentorg reads 7/);
  const unchanged = new DatabaseSync(file);
  t.after(() => unchanged.close());
  assert.equal(unchanged.prepare("PRAGMA user_version").get()?.user_version, 6);
  assert.equal(unchanged.prepare("SELECT value FROM kept").get()?.value, "kept");
});

test("a former delivery owner's late result cannot settle the current owner's call", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const org = organization(store, { waitMs: 0 });
  const { root } = await org.registry.createRoot();
  const { actor } = await org.registry.create(root.id, "worker", "Work");
  let finishOld!: (result: Outcome) => void;
  let finishCurrent!: (result: Outcome) => void;
  const oldResult = new Promise<Outcome>((resolve) => {
    finishOld = resolve;
  });
  const currentResult = new Promise<Outcome>((resolve) => {
    finishCurrent = resolve;
  });
  const former = { ...link(), deliver: async () => oldResult };
  const current = { ...link(), deliver: async () => currentResult };
  org.begin(actor.id, former);
  org.online(actor.id, former, [iface("work")]);
  const answer = await org.invoke(root.id, "worker.work", {}, invocation);
  assert.equal(answer.state, "pending");
  if (answer.state !== "pending") return;
  org.begin(actor.id, current);
  org.online(actor.id, current, [iface("work")]);
  finishOld({ ok: true, value: { owner: "former" }, parts: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(org.calls.found(answer.call).state, "pending");
  finishCurrent({ ok: true, value: { owner: "current" }, parts: [] });
  await until(
    "current owner settles the call",
    () => org.calls.found(answer.call).state === "done",
  );
  assert.deepEqual(org.calls.found(answer.call).output?.value, { owner: "current" });
});

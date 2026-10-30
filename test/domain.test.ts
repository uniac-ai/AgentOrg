/** State owners independently, and the triggers and views assembled over their clients. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import { application } from "../src/domain/application.ts";
import { audit } from "../src/domain/audit.ts";
import { calls } from "../src/domain/calls.ts";
import { capabilities } from "../src/domain/capabilities.ts";
import { connections } from "../src/domain/connections.ts";
import { organization } from "../src/domain/index.ts";
import type { Delivery, Outcome } from "../src/domain/model/index.ts";
import { toolDefinition } from "../src/domain/model/json-schema.ts";
import { type ActorLink, UnknownRun } from "../src/domain/ports.ts";
import { registry } from "../src/domain/registry.ts";
import { bindTool } from "../src/domain/tools.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";
import { iface, until } from "./harness.ts";

const invocation = { cause: null, signal: new AbortController().signal, progress: async () => {} };
const link = (): ActorLink => ({
  deliver: async () => ({ ok: true, value: {}, parts: [] }),
  outcome: async () => ({ ok: true, value: {}, parts: [] }),
  cancel: async () => {},
  close: async () => {},
});

test("core exposure and invocation come only from composed feature operations", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const now = () => "2026-10-30T00:00:00Z";
  const actors = registry(store.actors, now);
  const { root } = await actors.createRoot();
  const { actor: child } = await actors.create(root.id, "child", "Child");
  const activity = audit(store.audit, now);
  const connected = connections(
    store.exposures,
    () => {},
    () => {},
  );
  const calling = calls(store.calls, connected, activity, now);
  const definition = toolDefinition("notes", {
    note: {
      writes: true,
      description: "Record a note.",
      request: z.strictObject({ text: z.string() }),
      response: z.strictObject({ id: z.string(), text: z.string() }),
    },
  });
  let invoked = 0;
  const tool = bindTool(definition, {
    note: (_actor, request, context) => {
      invoked++;
      assert.deepEqual(
        context.catalog.map((each) => each.id),
        ["hub:notes"],
      );
      return { id: "note_1", text: request.text };
    },
  });
  const offered = capabilities(actors, connected, [tool]);
  const app = application(actors, offered, calling, activity, { waitMs: 0, stepMs: 1000 });
  const exposed = offered.list(root)[0]?.interfaces[0];
  assert.ok(exposed && "operation" in exposed);
  assert.equal(exposed.operation.definition, definition.interfaces.note);
  assert.deepEqual(
    app.available(root.id).map((each) => each.name),
    ["notes"],
  );
  assert.deepEqual(app.available(child.id), app.available(root.id));
  assert.equal((await app.invoke(child.id, "note", { text: "Shared" }, invocation)).state, "done");
  assert.equal((await app.invoke(root.id, "note", {}, invocation)).state, "refused");
  assert.equal(
    (await app.invoke(root.id, "actor_create", { name: "absent", purpose: "Absent" }, invocation))
      .state,
    "refused",
  );
  assert.deepEqual(await app.invoke(root.id, "note", { text: "Saved" }, invocation), {
    state: "done",
    value: { id: "note_1", text: "Saved" },
  });
  assert.equal(invoked, 2);
  assert.equal(activity.list(undefined, 1)[0]?.operation, "note");
  const empty = application(actors, capabilities(actors, connected, []), calling, activity, {
    waitMs: 0,
    stepMs: 1000,
  });
  assert.deepEqual(empty.available(root.id), []);
  assert.equal(
    (await empty.invoke(root.id, "note", { text: "Absent" }, invocation)).state,
    "refused",
  );
  assert.equal(invoked, 2);
});

test("Tool listing, dispatch and team use the same current exposure through offline, replacement and closure", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const org = organization(store, { waitMs: 0 });
  const { root } = await org.registry.createRoot();
  const { actor: lead } = await org.registry.create(root.id, "lead", "Lead");
  const { actor: worker } = await org.registry.create(lead.id, "worker", "Work");
  const { actor: other } = await org.registry.create(root.id, "other", "Other");
  assert.equal(
    org.available(root.id).some((tool) => tool.id === lead.id),
    false,
  );
  const empty = link();
  org.begin(lead.id, empty);
  org.online(lead.id, empty, []);
  assert.equal(org.connections.link(lead.id), empty);
  assert.equal(
    org.available(root.id).some((tool) => tool.id === lead.id),
    false,
  );
  const channel = link();
  org.begin(worker.id, channel);
  org.online(worker.id, channel, [iface("review")]);
  const otherChannel = link();
  org.begin(other.id, otherChannel);
  org.online(other.id, otherChannel, [iface("secret")]);
  const tool = () => org.available(lead.id).find((each) => each.id === worker.id);
  assert.equal(tool()?.interfaces[0]?.call, "worker.review");
  assert.equal(
    org.available(lead.id).some((each) => each.id === other.id),
    false,
  );
  assert.equal((await org.invoke(lead.id, "other.secret", {}, invocation)).state, "refused");
  assert.equal((await org.invoke(lead.id, "lead.worker.review", {}, invocation)).state, "refused");
  org.offline(worker.id, channel);
  assert.equal(tool()?.interfaces[0]?.interface.name, "review");
  assert.notEqual((await org.invoke(lead.id, "worker.review", {}, invocation)).state, "refused");
  const replacement = link();
  org.begin(worker.id, replacement);
  org.online(worker.id, replacement, [iface("publish")]);
  assert.deepEqual(
    tool()?.interfaces.map((offer) => [offer.interface.name, offer.call]),
    [["publish", "worker.publish"]],
  );
  assert.equal((await org.invoke(lead.id, "worker.review", {}, invocation)).state, "refused");
  assert.notEqual((await org.invoke(lead.id, "worker.publish", {}, invocation)).state, "refused");
  const team = await org.invoke(lead.id, "team", {}, invocation);
  assert.equal(team.state, "done");
  if (team.state === "done") {
    const positions = (team.value as { positions: { id: string; interfaces: string[] }[] })
      .positions;
    assert.deepEqual(positions.find((each) => each.id === worker.id)?.interfaces, [
      "worker.publish",
    ]);
  }
  await org.invoke(lead.id, "actor_close", { actor: worker.id }, invocation);
  assert.equal(tool(), undefined);
  assert.equal((await org.invoke(lead.id, "worker.publish", {}, invocation)).state, "refused");
  assert.deepEqual(org.available(worker.id), []);
  assert.equal((await org.invoke(worker.id, "team", {}, invocation)).state, "refused");
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
  const former = {
    ...link(),
    deliver: async () => ({ run: "former-run" }),
    outcome: async () => oldResult,
  };
  const current = {
    ...link(),
    deliver: async () => ({ run: "current-run" }),
    outcome: async (run: string) => {
      if (run !== "current-run") throw new UnknownRun();
      return currentResult;
    },
  };
  org.begin(actor.id, former);
  org.online(actor.id, former, [iface("work")]);
  const answer = await org.invoke(root.id, "worker.work", {}, invocation);
  assert.equal(answer.state, "pending");
  if (answer.state !== "pending") return;
  await until(
    "former owner starts its run",
    () => org.calls.found(answer.call).run === "former-run",
  );
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

test("a former owner's late task acceptance cannot overwrite the current run", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const org = organization(store, { waitMs: 0 });
  const { root } = await org.registry.createRoot();
  const { actor } = await org.registry.create(root.id, "worker", "Work");
  let acceptFormer!: (result: { run: string }) => void;
  let finishCurrent!: (result: Outcome) => void;
  const acceptance = new Promise<{ run: string }>((resolve) => {
    acceptFormer = resolve;
  });
  const outcome = new Promise<Outcome>((resolve) => {
    finishCurrent = resolve;
  });
  const former = { ...link(), deliver: async () => acceptance };
  const current = {
    ...link(),
    deliver: async () => ({ run: "current-run" }),
    outcome: async () => outcome,
  };
  org.begin(actor.id, former);
  org.online(actor.id, former, [iface("work")]);
  const answer = await org.invoke(root.id, "worker.work", {}, invocation);
  assert.equal(answer.state, "pending");
  if (answer.state !== "pending") return;
  org.begin(actor.id, current);
  org.online(actor.id, current, [iface("work")]);
  await until(
    "current owner accepts its run",
    () => org.calls.found(answer.call).run === "current-run",
  );
  acceptFormer({ run: "former-run" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(org.calls.found(answer.call).run, "current-run");
  finishCurrent({ ok: true, value: {}, parts: [] });
  await until("current run settles", () => org.calls.found(answer.call).state === "done");
});

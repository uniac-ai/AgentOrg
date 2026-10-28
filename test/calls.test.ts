/** Wiring, routed calls, the built-ins and long-running calls, between fake actors on a real core. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import type { Answer } from "../src/domain/model/index.ts";
import { CLOSE_REVOKED } from "../src/network/index.ts";
import {
  type Core,
  done,
  type FakeActor,
  fakeActor,
  iface,
  type Json,
  startCore,
  until,
} from "./harness.ts";

const DECIDE = iface("decide", {
  input: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  output: { type: "object", properties: { choice: { type: "string" } }, required: ["choice"] },
  long_running: true,
});
const NOTE = iface("note", {
  input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  output: { type: "object", properties: {} },
  one_way: true,
  long_running: true,
});
const APPROVE = iface("approve", {
  output: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
});
const REVIEW = iface("review", {
  input: { type: "object", properties: { change: { type: "string" } }, required: ["change"] },
  output: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
});

/** The call a pending answer names. */
function pendingCall(answer: Answer): string {
  if (answer.state !== "pending") throw new Error(`not pending: ${JSON.stringify(answer)}`);
  return answer.call;
}

async function report(core: Core, manager: Actor, name: string, actor: FakeActor) {
  const created = await done(manager.call("actor_create", { name, purpose: `The ${name} work` }));
  const id = created.actor.id as string;
  const credential = created.credential as string;
  const connection = await core.connect(credential, actor);
  await until(`${name} online`, () => core.org.registry.get(id)?.online === true);
  return { id, credential, connection, actor };
}

/**
 * The root (with decide and note, long-running), its report release (approve), and release's
 * report storage (review).
 */
async function organization(
  options: Parameters<typeof startCore>[0] = {},
  storageActor = fakeActor([REVIEW], async () => ({ value: { verdict: "ok" } })),
) {
  const core = await startCore({ waitMs: 2000, stepMs: 50, timeoutMs: 2000, ...options });
  const rootActor = fakeActor([DECIDE, NOTE]);
  const root = await core.connect(core.root, rootActor);
  await until("root online", () => core.org.registry.get(core.rootId)?.online === true);
  const releaseActor = fakeActor([APPROVE], async () => ({ value: { approved: true } }));
  const release = await report(core, root, "release", releaseActor);
  const storage = await report(core, release.connection, "storage", storageActor);
  return { core, root, rootActor, release, storage };
}

const names = async (actor: Actor) => (await actor.available()).map((each) => each.interface.name);
const BUILTINS = [
  "actor_create",
  "actor_close",
  "status_set",
  "view",
  "progress_set",
  "team",
  "progress",
  "message_send",
  "messages",
  "message_read",
  "call_result",
  "call_withdraw",
];

test("each actor is offered the built-ins and the interfaces one step up and down; the root every actor's", async () => {
  const { core, root, release, storage } = await organization();
  try {
    assert.deepEqual(await names(release.connection), [
      ...BUILTINS,
      "manager.decide",
      "manager.note",
      "storage.review",
    ]);
    assert.deepEqual(await names(storage.connection), [...BUILTINS, "manager.approve"]);
    assert.deepEqual(await names(root), [
      ...BUILTINS,
      "activity",
      "release.approve",
      "release.storage.review",
    ]);
    const decide = (await release.connection.available()).find(
      (each) => each.interface.name === "manager.decide",
    );
    assert.equal(decide?.routed, true);
    assert.deepEqual(decide?.interface.output, DECIDE.output);
    const listed = core.org.registry
      .get(core.rootId)
      ?.interfaces.map((each) => [each.name, each.one_way, each.long_running]);
    assert.deepEqual(listed, [
      ["decide", false, true],
      ["note", true, true],
    ]);
  } finally {
    await core.close();
  }
});

test("two actors call each other up and down, and the root calls any actor by its path", async () => {
  let storageConnection: Actor | undefined;
  const storageActor = fakeActor([REVIEW], async (_input, call) => {
    // While handling release's call, storage asks release, its manager, naming the call as cause.
    const approval = await done(
      (storageConnection as Actor).call("manager.approve", {}, { cause: call.id }),
    );
    return { value: { verdict: approval.approved ? "approved" : "refused" } };
  });
  const { core, root, release, storage } = await organization({}, storageActor);
  storageConnection = storage.connection;
  try {
    const down = await release.connection.call("storage.review", { change: "schema v2" });
    assert.equal(down.state, "done");
    assert.deepEqual(await done(down), { verdict: "approved" });
    const call = core.org.calls.found(down.state === "done" ? (down.call as string) : "");
    assert.equal(call.from, release.id);
    assert.equal(call.to, storage.id);
    assert.equal(call.interface, "review");
    assert.deepEqual(call.input, { change: "schema v2" });
    const { id, from, cause } = storage.actor.received[0]?.call ?? {};
    assert.deepEqual({ id, from, cause }, { id: call.id, from: release.id, cause: null });

    const [up] = core.store.database.select("calls", `"from" = ?`, [storage.id]);
    assert.equal(up?.to, release.id);
    assert.equal(up?.cause, call.id);
    assert.equal(up?.state, "done");

    const fromRoot = await root.call("release.storage.review", { change: "index" });
    assert.deepEqual(await done(fromRoot), { verdict: "approved" });
    const rootCall = fromRoot.state === "done" ? (fromRoot.call as string) : "";
    assert.equal(core.org.calls.found(rootCall).from, core.rootId);
  } finally {
    await core.close();
  }
});

test("input that breaks the callee's input schema is refused, and output that breaks its output schema fails the call", async () => {
  const outputs = [{ value: { verdict: 3 } }, { parts: [{ type: "text", text: "ok" }] }];
  const { core, release } = await organization(
    {},
    fakeActor([REVIEW], async () => outputs.shift() ?? {}),
  );
  try {
    const actor = release.connection;
    const before = core.store.database.count("calls", "1");
    const refused = await actor.call("storage.review", { change: 5 });
    assert.equal(refused.state === "refused" && refused.code, "invalid");
    assert.match(
      refused.state === "refused" ? refused.message : "",
      /^the input does not match the input schema of storage\.review/,
    );
    assert.equal(core.store.database.count("calls", "1"), before, "a refused call is not recorded");

    const wrongShape = await actor.call("storage.review", { change: "a" });
    assert.match(
      wrongShape.state === "failed" ? wrongShape.error : "",
      /^the output does not match the output schema of review/,
    );
    const unstructured = await actor.call("storage.review", { change: "b" });
    assert.match(unstructured.state === "failed" ? unstructured.error : "", /no structured value/);
    const states = core.store.database
      .select("calls", `"from" = ?`, [release.id])
      .map((each) => each.state);
    assert.deepEqual(states, ["failed", "failed"]);

    const unknown = await actor.call("storage.drop");
    assert.deepEqual(unknown, {
      state: "refused",
      code: "not_found",
      message: "there is no interface storage.drop",
    });
  } finally {
    await core.close();
  }
});

test("a long-running call answers pending with progress, and its result arrives when the actor finishes it", async () => {
  const { core, rootActor, release } = await organization({ waitMs: 300 });
  try {
    const actor = release.connection;
    const progress: string[] = [];
    const first = await actor.call(
      "manager.decide",
      { question: "Ship?" },
      { progress: (message) => progress.push(message) },
    );
    const id = pendingCall(first);
    assert.ok(progress.length > 0, "the wait reported progress");
    assert.equal(rootActor.held.length, 1);
    assert.notEqual(core.org.calls.found(id).run, null, "the actor runs it long");

    const waiting = done(actor.call("call_result", { call: id, wait: 30 }));
    rootActor.held[0]?.complete({ value: { choice: "yes" } });
    const settled = await waiting;
    assert.equal(settled.state, "done");
    assert.deepEqual(settled.output.value, { choice: "yes" });
  } finally {
    await core.close();
  }
});

test("a one-way call answers pending at once and is done when the actor finishes it", async () => {
  const { core, rootActor, release } = await organization({ waitMs: 60_000 });
  try {
    const call = release.connection.call("manager.note", { text: "FYI" });
    const guard = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("manager.note never answered before the root finished")),
        5000,
      ),
    );
    const id = pendingCall(await Promise.race([call, guard]));
    await until("the root holds the note", () => rootActor.held.length === 1);
    rootActor.held[0]?.complete({ value: {} });
    await until("note done", () => core.org.calls.found(id).state === "done");
  } finally {
    await core.close();
  }
});

test("a call waits for an offline actor, and a call in flight is delivered again after a reconnect", async () => {
  let hang = true;
  const storageActor = fakeActor([REVIEW], async () =>
    hang ? new Promise(() => {}) : { value: { verdict: "ok" } },
  );
  const { core, release, storage } = await organization({ waitMs: 200 }, storageActor);
  try {
    const actor = release.connection;
    // In flight: the actor holds the call when its connection drops, and gets it again.
    const inFlight = pendingCall(await actor.call("storage.review", { change: "a" }));
    await until("delivered once", () => storageActor.received.length === 1);
    hang = false;
    core.drop();
    await until("delivered again", () => storageActor.received.length >= 2);
    const ids = storageActor.received.map((each) => each.call.id);
    assert.deepEqual(new Set(ids), new Set([inFlight]));
    await until("done", () => core.org.calls.found(inFlight).state === "done");

    // Offline: the call waits, undelivered, until the actor connects.
    await storage.connection.close();
    await until("storage offline", () => core.org.registry.get(storage.id)?.online === false);
    const waiting = pendingCall(await actor.call("storage.review", { change: "b" }));
    assert.equal(core.org.calls.found(waiting).delivered_at, null);
    await core.connect(storage.credential, storageActor);
    const settled = await done(actor.call("call_result", { call: waiting, wait: 30 }));
    assert.equal(settled.state, "done");
  } finally {
    await core.close();
  }
});

test("after the actor restarts, its pending run is delivered again and the answer reaches the caller; a reconnect alone keeps the run", async () => {
  const { core, root, rootActor, release } = await organization({ waitMs: 100 });
  try {
    const actor = release.connection;
    // A reconnect without a restart: the same actor, with its runs, connects again.
    const kept = pendingCall(await actor.call("manager.decide", { question: "Keep?" }));
    await until("run held", () => rootActor.held.length === 1);
    core.drop();
    await until("root online again", () => core.org.registry.get(core.rootId)?.online === true);
    rootActor.held[0]?.complete({ value: { choice: "kept" } });
    await until("kept done", () => core.org.calls.found(kept).state === "done");
    assert.equal(rootActor.received.length, 1, "the held run was not delivered again");

    // A restart: the actor comes back with nothing held.
    const asked = pendingCall(await actor.call("manager.decide", { question: "Ship?" }));
    await until("second run held", () => rootActor.held.length === 2);
    await root.close();
    const restarted = fakeActor([DECIDE, NOTE]);
    await core.connect(core.root, restarted);
    await until("delivered to the restarted actor", () => restarted.held.length === 1);
    assert.equal(restarted.received[0]?.call.id, asked);
    restarted.held[0]?.complete({ value: { choice: "ship" } });
    const settled = await done(actor.call("call_result", { call: asked, wait: 30 }));
    assert.equal(settled.state, "done");
    assert.deepEqual(settled.output.value, { choice: "ship" });
  } finally {
    await core.close();
  }
});

test("call records survive a restart of the core, and pending calls are delivered when actors connect again", async () => {
  const { core, release, storage } = await organization({ waitMs: 100 });
  try {
    await storage.connection.close();
    await until("storage offline", () => core.org.registry.get(storage.id)?.online === false);
    const pending = pendingCall(await release.connection.call("storage.review", { change: "c" }));
    await core.restart();
    await until(
      "release connected again",
      () => core.org.registry.get(release.id)?.online === true,
    );
    await core.connect(storage.credential, storage.actor);
    await until("done after the restart", () => core.org.calls.found(pending).state === "done");
    const settled = await done(release.connection.call("call_result", { call: pending }));
    assert.equal(settled.state, "done");
  } finally {
    await core.close();
  }
});

test("the caller withdraws its pending call, and the actor's handler sees it withdrawn", async () => {
  const { core, rootActor, release, storage } = await organization({ waitMs: 100 });
  try {
    const actor = release.connection;
    const id = pendingCall(await actor.call("manager.decide", { question: "Ship?" }));
    await until("run held", () => rootActor.held.length === 1);
    const forbidden = await storage.connection.call("call_withdraw", { call: id });
    assert.equal(forbidden.state === "refused" && forbidden.code, "forbidden");

    const withdrawn = await done(actor.call("call_withdraw", { call: id }));
    assert.equal(withdrawn.state, "withdrawn");
    await until(
      "the handler's signal aborted",
      () => rootActor.held[0]?.call.signal.aborted === true,
    );
    const again = await actor.call("call_withdraw", { call: id });
    assert.match(again.state === "refused" ? again.message : "", /^call .* is already withdrawn/);
  } finally {
    await core.close();
  }
});

test("an actor is closed by its manager once its reports are, which ends its calls and its connection", async () => {
  const { core, root, release, storage } = await organization({ waitMs: 100 });
  try {
    const refused = await root.call("actor_close", { actor: release.id });
    assert.match(
      refused.state === "refused" ? refused.message : "",
      /^release has open reports \(storage\)/,
    );
    const notTheirs = await storage.connection.call("actor_close", { actor: release.id });
    assert.equal(notTheirs.state === "refused" && notTheirs.code, "forbidden");

    // storage has a call pending into its manager, offline for now, and one pending into it.
    await core.org.link(release.id)?.close();
    await until("release offline", () => core.org.registry.get(release.id)?.online === false);
    const own = pendingCall(await storage.connection.call("manager.approve"));
    await storage.connection.close();
    const hanging = fakeActor([REVIEW], () => new Promise(() => {}));
    const reconnected = await core.connect(storage.credential, hanging);
    const into = pendingCall(await release.connection.call("storage.review", { change: "x" }));
    await until("delivered", () => hanging.received.length === 1);

    const closed = await done(release.connection.call("actor_close", { actor: storage.id }));
    const ended = closed.ended_calls as { id: string; state: string; error: string | null }[];
    assert.deepEqual(
      ended.map((call) => [call.id, call.state, call.error]),
      [
        [own, "withdrawn", null],
        [into, "failed", "storage was closed"],
      ],
    );
    await until("connection ended", () => reconnected.ended === CLOSE_REVOKED);
    assert.deepEqual(await names(release.connection), [
      ...BUILTINS,
      "manager.decide",
      "manager.note",
    ]);
    const login = await fetch(`${core.url}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${storage.credential}` },
    });
    assert.equal(login.status, 401);
  } finally {
    await core.close();
  }
});

test("status and views: what is pending on an actor and from whom, and the activity for the root only", async () => {
  const { core, root, rootActor, release, storage } = await organization({ waitMs: 100 });
  try {
    await done(storage.connection.call("status_set", { state: "running", summary: "Reviewing" }));
    const asked = pendingCall(
      await release.connection.call("manager.decide", { question: "Ship?" }),
    );
    await until("run held", () => rootActor.held.length === 1);

    const own = await done(release.connection.call("view"));
    assert.deepEqual(
      own.reports.map((each: Json) => [each.name, each.status.state, each.status.summary]),
      [["storage", "running", "Reviewing"]],
    );
    assert.deepEqual(
      own.open_calls.map((call: Json) => call.id),
      [asked],
    );

    const rootView = await done(root.call("view"));
    assert.deepEqual(
      rootView.pending.map((call: Json) => call.id),
      [asked],
    );
    assert.equal(rootView.names[release.id], "release");
    const ofStorage = await done(root.call("view", { actor: storage.id }));
    assert.equal(ofStorage.actor.path, "release.storage");
    const fromRelease = await done(release.connection.call("view", { actor: storage.id }));
    assert.equal(fromRelease.manager.name, "release");
    const upward = await storage.connection.call("view", { actor: release.id });
    assert.equal(upward.state === "refused" && upward.code, "forbidden");

    const activity = await done(root.call("activity", { limit: 5 }));
    const entries = activity.entries as { operation: string; outcome: string; target: string }[];
    assert.deepEqual(entries[0], {
      ...entries[0],
      operation: "call",
      target: asked,
      outcome: "pending",
    });
    assert.ok(entries.some((entry) => entry.operation === "status_set"));
    const hidden = await release.connection.call("activity");
    assert.equal(hidden.state === "refused" && hidden.code, "not_found");
  } finally {
    await core.close();
  }
});

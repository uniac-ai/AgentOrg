/** Wiring, routed calls, the built-ins and long-running calls, between fake actors on a real core. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActorConnection } from "../src/protocol/index.ts";
import { CALL_META, CAUSE_META, CLOSE_ACTOR_CLOSED, MCP_PATH } from "../src/protocol/index.ts";
import { type FakeActor, fakeActor, startCore, structured, tool, until } from "./harness.ts";

const DECIDE = tool("decide", {
  inputSchema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
  outputSchema: {
    type: "object",
    properties: { choice: { type: "string" } },
    required: ["choice"],
  },
  execution: { taskSupport: "optional" },
});
const NOTE = tool("note", {
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  outputSchema: { type: "object", properties: {} },
  execution: { taskSupport: "optional" },
});
const APPROVE = tool("approve", {
  outputSchema: {
    type: "object",
    properties: { approved: { type: "boolean" } },
    required: ["approved"],
  },
});
const REVIEW = tool("review", {
  inputSchema: { type: "object", properties: { change: { type: "string" } }, required: ["change"] },
  outputSchema: {
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"],
  },
});

type Core = Awaited<ReturnType<typeof startCore>>;
type Json = Record<string, unknown>;

/** The call id in a delivered call's or a result's `_meta`. */
const callId = (meta: Record<string, unknown> | undefined) =>
  (meta?.[CALL_META] as { id: string } | undefined)?.id;

const textOf = (result: CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

/** Call a tool and return its structured content, failing on an error result. */
async function use(client: Client, name: string, args: Json = {}): Promise<Json> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) throw new Error(`${name}: ${textOf(result)}`);
  return result.structuredContent as Json;
}

async function report(core: Core, manager: ActorConnection, name: string, actor: FakeActor) {
  const created = await use(manager.client, "actor_create", { name, purpose: `The ${name} work` });
  const id = (created.actor as { id: string }).id;
  const credential = created.credential as string;
  const connection = await core.connect(credential, actor);
  await until(`${name} online`, () => core.core.registry.get(id)?.online === true);
  return { id, credential, connection, actor };
}

/**
 * The root (with decide and note, as tasks), its report release (approve), and release's report
 * storage (review).
 */
async function organization(
  options: Parameters<typeof startCore>[0] = {},
  storageActor = fakeActor([REVIEW], async () => structured({ verdict: "ok" })),
) {
  const core = await startCore({ waitMs: 2000, stepMs: 50, timeoutMs: 2000, ...options });
  const rootActor = fakeActor([DECIDE, NOTE], undefined, { tasks: true });
  const root = await core.connect(core.root, rootActor);
  await until("root online", () => core.core.registry.get(core.rootId)?.online === true);
  const release = await report(
    core,
    root,
    "release",
    fakeActor([APPROVE], async () => structured({ approved: true })),
  );
  const storage = await report(core, release.connection, "storage", storageActor);
  return { core, root, rootActor, release, storage };
}

const names = async (client: Client) => (await client.listTools()).tools.map((each) => each.name);
const BUILTINS = [
  "actor_create",
  "actor_close",
  "status_set",
  "view",
  "call_result",
  "call_withdraw",
];

test("each actor lists the built-ins and the tools one step up and down; the root lists every actor's", async () => {
  const { core, root, release, storage } = await organization();
  try {
    assert.deepEqual(await names(release.connection.client), [
      ...BUILTINS,
      "manager.decide",
      "manager.note",
      "storage.review",
    ]);
    assert.deepEqual(await names(storage.connection.client), [...BUILTINS, "manager.approve"]);
    assert.deepEqual(await names(root.client), [
      ...BUILTINS,
      "activity",
      "release.approve",
      "release.storage.review",
    ]);
    const decide = (await release.connection.client.listTools()).tools.find(
      (each) => each.name === "manager.decide",
    );
    assert.equal(decide?.execution, undefined, "the core answers routed calls without tasks");
    assert.ok(Array.isArray(decide?.outputSchema?.anyOf), "the output is the tool's or pending");
  } finally {
    await core.close();
  }
});

test("two actors call each other up and down, and the root calls any actor by its path", async () => {
  let storageClient: Client | undefined;
  const storageActor = fakeActor([REVIEW], async (params) => {
    // While handling release's call, storage asks release, its manager, naming the call as cause.
    const delivered = params._meta?.[CALL_META] as { id: string };
    const approval = (await storageClient?.callTool({
      name: "manager.approve",
      arguments: {},
      _meta: { [CAUSE_META]: delivered.id },
    })) as CallToolResult;
    const { approved } = approval.structuredContent as { approved: boolean };
    return structured({ verdict: approved ? "approved" : "refused" });
  });
  const { core, root, release, storage } = await organization({}, storageActor);
  storageClient = storage.connection.client;
  try {
    const down = (await release.connection.client.callTool({
      name: "storage.review",
      arguments: { change: "schema v2" },
    })) as CallToolResult;
    assert.deepEqual(down.structuredContent, { verdict: "approved" });
    const receipt = down._meta?.[CALL_META] as { id: string; state: string };
    assert.equal(receipt.state, "done");

    const call = core.core.calls.found(receipt.id);
    assert.equal(call.from, release.id);
    assert.equal(call.to, storage.id);
    assert.equal(call.tool, "review");
    assert.deepEqual(call.input, { change: "schema v2" });
    const delivered = storage.actor.received[0]?._meta?.[CALL_META];
    assert.deepEqual(delivered, { id: call.id, from: release.id, cause: null });

    const up = core.core.store.select("calls", `"from" = ?`, [storage.id])[0];
    assert.equal(up?.to, release.id);
    assert.equal(up?.cause, call.id);
    assert.equal(up?.state, "done");

    const fromRoot = (await root.client.callTool({
      name: "release.storage.review",
      arguments: { change: "index" },
    })) as CallToolResult;
    assert.deepEqual(fromRoot.structuredContent, { verdict: "approved" });
    assert.equal(core.core.calls.found(callId(fromRoot._meta) as string).from, core.rootId);
  } finally {
    await core.close();
  }
});

test("input that breaks the callee's input schema is refused, and output that breaks its output schema fails the call", async () => {
  const outputs = [
    structured({ verdict: 3 }),
    { content: [{ type: "text" as const, text: "ok" }] },
  ];
  const { core, release } = await organization(
    {},
    fakeActor([REVIEW], async () => outputs.shift() as CallToolResult),
  );
  try {
    const client = release.connection.client;
    const before = core.core.store.count("calls", "1");
    const refused = (await client.callTool({
      name: "storage.review",
      arguments: { change: 5 },
    })) as CallToolResult;
    assert.equal(refused.isError, true);
    assert.match(
      textOf(refused),
      /^invalid: the input does not match the input schema of storage\.review/,
    );
    assert.equal(core.core.store.count("calls", "1"), before, "a refused call is not recorded");

    const wrongShape = (await client.callTool({
      name: "storage.review",
      arguments: { change: "a" },
    })) as CallToolResult;
    assert.equal(wrongShape.isError, true);
    assert.match(
      textOf(wrongShape),
      /failed: the output does not match the output schema of review/,
    );
    const unstructured = (await client.callTool({
      name: "storage.review",
      arguments: { change: "b" },
    })) as CallToolResult;
    assert.match(textOf(unstructured), /it has no structured content/);
    const states = core.core.store.select("calls", `"from" = ?`, [release.id]).map((c) => c.state);
    assert.deepEqual(states, ["failed", "failed"]);

    const unknown = (await client.callTool({
      name: "storage.drop",
      arguments: {},
    })) as CallToolResult;
    assert.match(textOf(unknown), /^not_found: there is no tool storage\.drop/);
  } finally {
    await core.close();
  }
});

test("a long-running call returns pending with progress, and its result arrives when the actor's task finishes", async () => {
  const { core, rootActor, release } = await organization({ waitMs: 300 });
  try {
    const client = release.connection.client;
    await client.listTools();
    const progress: number[] = [];
    const first = (await client.callTool(
      { name: "manager.decide", arguments: { question: "Ship?" } },
      undefined,
      {
        onprogress: (notification) => progress.push(notification.progress),
      },
    )) as CallToolResult;
    const pending = first.structuredContent as { call: string; state: string };
    assert.equal(pending.state, "pending");
    assert.ok(progress.length > 0, "the wait reported progress");
    assert.equal(rootActor.tasks.length, 1);
    assert.equal(core.core.calls.found(pending.call).task, rootActor.tasks[0]?.taskId);

    const waiting = use(client, "call_result", { call: pending.call, wait: 30 });
    await rootActor.tasks[0]?.complete(structured({ choice: "yes" }));
    const settled = await waiting;
    assert.equal(settled.state, "done");
    assert.deepEqual((settled.output as CallToolResult).structuredContent, { choice: "yes" });
  } finally {
    await core.close();
  }
});

test("a one-way call returns pending at once and is done when the actor's task finishes", async () => {
  const { core, rootActor, release } = await organization({ waitMs: 60_000 });
  try {
    const call = release.connection.client.callTool({
      name: "manager.note",
      arguments: { text: "FYI" },
    });
    const guard = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("manager.note never returned before the root finished")),
        5000,
      ),
    );
    const result = (await Promise.race([call, guard])) as CallToolResult;
    const pending = result.structuredContent as { call: string; state: string };
    assert.equal(pending.state, "pending");
    await until("the root holds the note", () => rootActor.tasks.length === 1);
    await rootActor.tasks[0]?.complete(structured({}));
    await until("note done", () => core.core.calls.found(pending.call).state === "done");
  } finally {
    await core.close();
  }
});

test("a call waits for an offline actor, and a call in flight is delivered again after a reconnect", async () => {
  let hang = true;
  const storageActor = fakeActor([REVIEW], async () =>
    hang ? new Promise<CallToolResult>(() => {}) : structured({ verdict: "ok" }),
  );
  const { core, release, storage } = await organization({ waitMs: 200 }, storageActor);
  try {
    const client = release.connection.client;
    // In flight: the actor holds the call when its connection drops, and gets it again.
    const inFlight = (await use(client, "storage.review", { change: "a" })) as { call: string };
    await until("delivered once", () => storageActor.received.length === 1);
    hang = false;
    await core.core.connections.closeAll();
    await until("delivered again", () => storageActor.received.length >= 2);
    const ids = storageActor.received.map((params) => callId(params._meta));
    assert.deepEqual(new Set(ids), new Set([inFlight.call]));
    await until("done", () => core.core.calls.found(inFlight.call).state === "done");

    // Offline: the call waits, undelivered, until the actor connects.
    await storage.connection.close();
    await until("storage offline", () => core.core.registry.get(storage.id)?.online === false);
    const waiting = (await use(client, "storage.review", { change: "b" })) as { call: string };
    assert.equal(core.core.calls.found(waiting.call).delivered_at, null);
    await core.connect(storage.credential, storageActor);
    const settled = await use(client, "call_result", { call: waiting.call, wait: 30 });
    assert.equal(settled.state, "done");
  } finally {
    await core.close();
  }
});

test("after the actor restarts, its pending task is delivered again and the answer reaches the caller; a reconnect alone keeps the task", async () => {
  const { core, root, rootActor, release } = await organization({ waitMs: 100 });
  try {
    const client = release.connection.client;
    // A reconnect without a restart: the same server, with its tasks, dials again.
    const kept = (await use(client, "manager.decide", { question: "Keep?" })) as { call: string };
    await until("task held", () => rootActor.tasks.length === 1);
    await core.core.connections.closeAll();
    await until("root online again", () => core.core.registry.get(core.rootId)?.online === true);
    await rootActor.tasks[0]?.complete(structured({ choice: "kept" }));
    await until("kept done", () => core.core.calls.found(kept.call).state === "done");
    assert.equal(rootActor.received.length, 1, "the held task was not delivered again");

    // A restart: the human actor comes back with an empty task store.
    const asked = (await use(client, "manager.decide", { question: "Ship?" })) as { call: string };
    await until("second task held", () => rootActor.tasks.length === 2);
    await root.close();
    const restarted = fakeActor([DECIDE, NOTE], undefined, { tasks: true });
    await core.connect(core.root, restarted);
    await until("delivered to the restarted actor", () => restarted.tasks.length === 1);
    assert.equal(callId(restarted.received[0]?._meta), asked.call);
    await restarted.tasks[0]?.complete(structured({ choice: "ship" }));
    const settled = await use(client, "call_result", { call: asked.call, wait: 30 });
    assert.equal(settled.state, "done");
    assert.deepEqual((settled.output as CallToolResult).structuredContent, { choice: "ship" });
  } finally {
    await core.close();
  }
});

test("call records survive a restart of the core, and pending calls are delivered when actors dial again", async () => {
  const { core, release, storage } = await organization({ waitMs: 100 });
  try {
    await storage.connection.close();
    await until("storage offline", () => core.core.registry.get(storage.id)?.online === false);
    const pending = (await use(release.connection.client, "storage.review", { change: "c" })) as {
      call: string;
    };
    await core.restart();
    await until("release dialed again", () => core.core.registry.get(release.id)?.online === true);
    await core.connect(storage.credential, storage.actor);
    await until(
      "done after the restart",
      () => core.core.calls.found(pending.call).state === "done",
    );
    const settled = await use(release.connection.client, "call_result", { call: pending.call });
    assert.equal(settled.state, "done");
  } finally {
    await core.close();
  }
});

test("the caller withdraws its pending call, and the actor's task is cancelled", async () => {
  const { core, rootActor, release, storage } = await organization({ waitMs: 100 });
  try {
    const client = release.connection.client;
    const pending = (await use(client, "manager.decide", { question: "Ship?" })) as {
      call: string;
    };
    await until("task held", () => rootActor.tasks.length === 1);
    const forbidden = (await storage.connection.client.callTool({
      name: "call_withdraw",
      arguments: { call: pending.call },
    })) as CallToolResult;
    assert.match(textOf(forbidden), /^forbidden/);

    const withdrawn = await use(client, "call_withdraw", { call: pending.call });
    assert.equal(withdrawn.state, "withdrawn");
    const taskId = rootActor.tasks[0]?.taskId as string;
    await until(
      "task cancelled",
      async () => (await rootActor.taskStore?.getTask(taskId))?.status === "cancelled",
    );
    const again = (await client.callTool({
      name: "call_withdraw",
      arguments: { call: pending.call },
    })) as CallToolResult;
    assert.match(textOf(again), /^conflict: call .* is already withdrawn/);
  } finally {
    await core.close();
  }
});

test("an actor is closed by its manager once its reports are, which ends its calls and its connection", async () => {
  const { core, root, release, storage } = await organization({ waitMs: 100 });
  try {
    const refused = (await root.client.callTool({
      name: "actor_close",
      arguments: { actor: release.id },
    })) as CallToolResult;
    assert.match(textOf(refused), /^conflict: release has open reports \(storage\)/);
    const notTheirs = (await storage.connection.client.callTool({
      name: "actor_close",
      arguments: { actor: release.id },
    })) as CallToolResult;
    assert.match(textOf(notTheirs), /^forbidden/);

    // storage has a call pending into its manager, offline for now, and one pending into it.
    await core.core.connections.disconnect(release.id);
    await until("release offline", () => core.core.registry.get(release.id)?.online === false);
    const own = (await use(storage.connection.client, "manager.approve")) as { call: string };
    await storage.connection.close();
    const hanging = fakeActor([REVIEW], () => new Promise<CallToolResult>(() => {}));
    const reconnected = await core.connect(storage.credential, hanging);
    const into = (await use(release.connection.client, "storage.review", { change: "x" })) as {
      call: string;
    };
    await until("delivered", () => hanging.received.length === 1);

    const closed = await use(release.connection.client, "actor_close", { actor: storage.id });
    const ended = closed.ended_calls as { id: string; state: string; error: string }[];
    assert.deepEqual(
      ended.map((call) => [call.id, call.state, call.error]),
      [
        [own.call, "withdrawn", null],
        [into.call, "failed", "storage was closed"],
      ],
    );
    await until("connection ended", () => reconnected.ended === CLOSE_ACTOR_CLOSED);
    assert.deepEqual(await names(release.connection.client), [
      ...BUILTINS,
      "manager.decide",
      "manager.note",
    ]);
    const login = await fetch(`${core.url}${MCP_PATH}`, {
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
    // Listing first makes each client check every result against the tool's output schema.
    for (const client of [root.client, release.connection.client, storage.connection.client]) {
      await client.listTools();
    }
    await use(storage.connection.client, "status_set", { state: "running", summary: "Reviewing" });
    const asked = (await use(release.connection.client, "manager.decide", {
      question: "Ship?",
    })) as { call: string };
    await until("task held", () => rootActor.tasks.length === 1);

    const own = await use(release.connection.client, "view");
    const reports = own.reports as { name: string; status: { state: string; summary: string } }[];
    assert.deepEqual(
      reports.map((each) => [each.name, each.status.state, each.status.summary]),
      [["storage", "running", "Reviewing"]],
    );
    assert.deepEqual(
      (own.open_calls as { id: string }[]).map((call) => call.id),
      [asked.call],
    );

    const rootView = await use(root.client, "view");
    const pending = rootView.pending as { id: string; from: string }[];
    assert.deepEqual(
      pending.map((call) => call.id),
      [asked.call],
    );
    assert.equal((rootView.names as Record<string, string>)[release.id], "release");
    const ofStorage = await use(root.client, "view", { actor: storage.id });
    assert.equal((ofStorage.actor as { path: string }).path, "release.storage");
    const fromRelease = await use(release.connection.client, "view", { actor: storage.id });
    assert.equal((fromRelease.manager as { name: string }).name, "release");
    const upward = (await storage.connection.client.callTool({
      name: "view",
      arguments: { actor: release.id },
    })) as CallToolResult;
    assert.match(textOf(upward), /^forbidden/);

    const activity = await use(root.client, "activity", { limit: 5 });
    const entries = activity.entries as { operation: string; outcome: string; target: string }[];
    assert.deepEqual(entries[0], {
      ...entries[0],
      operation: "call",
      target: asked.call,
      outcome: "pending",
    });
    assert.ok(entries.some((entry) => entry.operation === "status_set"));
    const hidden = (await release.connection.client.callTool({
      name: "activity",
      arguments: {},
    })) as CallToolResult;
    assert.match(textOf(hidden), /^not_found/);
  } finally {
    await core.close();
  }
});

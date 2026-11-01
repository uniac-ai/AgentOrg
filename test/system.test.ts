/** Shared System contract through real ordinary sockets and isolated factory fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { type TestContext, test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import { CONNECTION_PATH, establish, type Identity } from "../src/connection/index.ts";
import { ConnectionPage, ProviderPage, SystemStatus } from "../src/contract/index.ts";
import { diagnostics } from "../src/domain/diagnostics.ts";
import { dial } from "../src/network/index.ts";
import { type Core, done, refused, startCore, until } from "./harness.ts";

const credential = "OWNED_PROVIDER_CREDENTIAL_SENTINEL";
const hash = createHash("sha256").update(credential).digest("hex");
const invocation = { signal: new AbortController().signal, progress: async () => {} };
const page = async (client: Actor, input: Record<string, unknown> = {}) =>
  ConnectionPage.parse(await done(client.call("connection_list", input)));
const providers = async (client: Actor, input: Record<string, unknown> = {}) =>
  ProviderPage.parse(await done(client.call("provider_list", input)));
const status = async (client: Actor) =>
  SystemStatus.parse(await done(client.call("system_status", { diagnosticLimit: 100 })));
const held = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t: TestContext, ids = ["factory"], timeoutMs = 60_000) {
  const core = await startCore({
    providers: ids.map((providerId) => ({ providerId, credentialHash: hash })),
    timeoutMs,
  });
  t.after(() => core.close());
  const root = await core.client(core.root);
  const make = async (name: string, manager: Actor = root) => {
    const result = await done(manager.call("actor_create", { name, purpose: name }));
    return {
      id: result.actor.id as string,
      credential: result.credential as string,
      client: await core.client(result.credential),
    };
  };
  return { core, root, make };
}
async function socket(t: TestContext, core: Core, identity: Identity) {
  const url = new URL(CONNECTION_PATH, core.url);
  url.protocol = "ws:";
  const raw = await dial(url);
  t.after(() => raw.close());
  const result = await establish(raw, identity);
  const closed = new Promise<number | undefined>((resolve) => raw.whenClosed(resolve));
  return { ...result, closed };
}
type Request = { id: string; method: string; params: { actorId: string } };
async function provider(
  t: TestContext,
  core: Core,
  id = "factory",
  respond?: (request: Request) => void,
) {
  const peer = await socket(t, core, { providerId: id, credential });
  const requests: Request[] = [];
  const reply = (request: Request, result: unknown) =>
    peer.channel.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  peer.channel.listen(
    (text) => {
      const request = JSON.parse(text) as Request;
      if (typeof request.method !== "string") return;
      requests.push(request);
      if (respond) respond(request);
      else
        reply(
          request,
          request.method === "provider.describe"
            ? { configSchema: { type: "object" } }
            : { actorId: request.params.actorId },
        );
    },
    () => {},
  );
  return { ...peer, requests, reply };
}

test("System is equally offered to active Actors; observations and sparse pages are run-scoped", async (t) => {
  const { core, root, make } = await fixture(t, ["offline-first", "factory", "offline-last"]);
  const worker = await make("worker");
  const raw = await socket(t, core, { actorId: worker.id, credential: worker.credential });
  const peer = await provider(t, core);
  assert.deepEqual(await root.available(), await worker.client.available());
  const tools = await root.available();
  assert.equal(tools.length, 10);
  assert.equal(tools.flatMap((tool) => tool.interfaces).length, 28);
  const system = tools.find((tool) => tool.id === "hub:system");
  assert.ok(system);
  assert.deepEqual(
    system.interfaces.map((offer) => [offer.call, offer.read_only]),
    [
      ["system_status", true],
      ["connection_list", true],
      ["provider_list", true],
      ["connection_disconnect", false],
    ],
  );
  const observed = await status(worker.client);
  assert.equal(observed.state, "serving");
  assert.equal(observed.nodeVersion, process.version);
  assert.equal(observed.configuredProviders, 3);
  assert.equal(observed.actorConnections, 3);
  assert.equal(observed.providerConnections, 1);
  assert.deepEqual(Object.keys(observed).sort(), [
    "actorConnections",
    "configuredProviders",
    "diagnostics",
    "instanceId",
    "nodeVersion",
    "observedAt",
    "providerConnections",
    "startedAt",
    "state",
    "version",
  ]);
  const first = await page(root, { actorId: worker.id, limit: 1 });
  assert.equal(first.items.length, 1);
  const next = await page(root, {
    actorId: worker.id,
    limit: 1,
    instanceId: first.instanceId,
    after: first.after,
  });
  assert.deepEqual(
    next.items.map((entry) => entry.connectionId),
    [raw.connectionId],
  );
  const filtered = await providers(worker.client, { connected: true, limit: 1 });
  assert.deepEqual(filtered.items, [
    {
      providerId: "factory",
      admittedConnections: 1,
      selectedConnectionId: peer.connectionId,
      activeCreations: 0,
    },
  ]);
  assert.equal(filtered.after, 2);
  assert.equal(
    (await providers(root, { connected: false, limit: 1 })).items[0]?.providerId,
    "offline-first",
  );
  assert.equal((await providers(root, { providerId: "unknown" })).items.length, 0);
  assert.equal((await page(root, { actorId: worker.id, providerId: "factory" })).items.length, 0);
  assert.equal(await refused(root.call("connection_list", { after: 1 })), "conflict");
  assert.equal(
    await refused(
      root.call("connection_list", { after: first.after, instanceId: crypto.randomUUID() }),
    ),
    "conflict",
  );
  assert.equal(
    await refused(root.call("provider_list", { after: 4, instanceId: first.instanceId })),
    "invalid",
  );
  for (const input of [{ after: -1 }, { limit: 101 }, { after: 0.5 }, { actorId: "" }])
    assert.equal(await refused(root.call("connection_list", input)), "invalid");
  await core.restart();
  await until("ordinary SDK reconnects after owned Hub restart", async () => {
    try {
      return (await root.call("system_status")).state === "done";
    } catch {
      return false;
    }
  });
  const restarted = await status(root);
  assert.notEqual(restarted.instanceId, observed.instanceId);
  assert.equal(
    await refused(
      root.call("connection_list", { after: first.after, instanceId: observed.instanceId }),
    ),
    "conflict",
  );
});

test("Actor detach uses canonical self-other/direct-manager/root authority and preserves revocation", async (t) => {
  const { core, root, make } = await fixture(t);
  const lead = await make("lead");
  const worker = await make("worker", lead.client);
  const grandchild = await make("grandchild", worker.client);
  const outsider = await make("outsider");
  const raw = await socket(t, core, { actorId: worker.id, credential: worker.credential });
  const query = { connectionId: raw.connectionId };
  for (const client of [root, lead.client, worker.client])
    assert.equal((await page(client, query)).items[0]?.canDisconnect, true);
  for (const client of [grandchild.client, outsider.client]) {
    const row = (await page(client, query)).items[0];
    assert.equal(row?.canDisconnect, false);
    assert.equal(row?.blockedBy, "forbidden");
    assert.equal(
      await refused(
        client.call("connection_disconnect", {
          instanceId: (await status(client)).instanceId,
          connectionId: raw.connectionId,
        }),
      ),
      "forbidden",
    );
  }
  const mine = (await page(worker.client, { actorId: worker.id })).items.find(
    (entry) => entry.blockedBy === "current_connection",
  );
  assert.ok(mine);
  const instanceId = (await status(root)).instanceId;
  assert.equal(
    await refused(
      worker.client.call("connection_disconnect", { instanceId, connectionId: mine.connectionId }),
    ),
    "conflict",
  );
  assert.equal(
    await refused(
      outsider.client.call("connection_disconnect", {
        instanceId,
        connectionId: raw.connectionId,
        actorId: core.rootId,
      }),
    ),
    "invalid",
  );
  assert.deepEqual(
    await done(
      worker.client.call("connection_disconnect", { instanceId, connectionId: raw.connectionId }),
    ),
    { instanceId, connectionId: raw.connectionId, closed: true },
  );
  assert.equal(await raw.closed, 1000);
  assert.equal((await done(worker.client.call("actor_get"))).state, "active");
  const another = await socket(t, core, { actorId: worker.id, credential: worker.credential });
  await done(
    lead.client.call("connection_disconnect", { instanceId, connectionId: another.connectionId }),
  );
  assert.equal(await another.closed, 1000);
  const reconnecting = await core.client(worker.credential);
  const ownRows = await page(reconnecting, { actorId: worker.id });
  const carrying = ownRows.items.find((entry) => entry.blockedBy === "current_connection");
  assert.ok(carrying);
  await done(
    root.call("connection_disconnect", { instanceId, connectionId: carrying.connectionId }),
  );
  await until("detached SDK socket reconnects with a new admission ID", async () => {
    try {
      const rows = await page(reconnecting, { actorId: worker.id });
      return rows.items.some(
        (entry) =>
          entry.blockedBy === "current_connection" && entry.connectionId !== carrying.connectionId,
      );
    } catch {
      return false;
    }
  });
  assert.equal(reconnecting.ended, undefined);
  await done(root.call("actor_close", { actor: grandchild.id }));
  await done(root.call("actor_close", { actor: worker.id }));
  await until(
    "revocation is terminal on every worker socket",
    () => worker.client.ended === 4001 && reconnecting.ended === 4001,
  );
  assert.equal(
    await refused(core.org.invoke(worker.id, "system_status", {}, invocation)),
    "forbidden",
  );
});

test("duplicate Provider sockets expose selected routing and detach requires canonical root", async (t) => {
  const { core, root, make } = await fixture(t);
  const worker = await make("worker");
  const first = await provider(t, core);
  const second = await provider(t, core);
  const instanceId = (await status(root)).instanceId;
  let view = (await providers(worker.client)).items[0];
  assert.equal(view?.admittedConnections, 2);
  assert.equal(view?.selectedConnectionId, second.connectionId);
  const denied = (await page(worker.client, { connectionId: first.connectionId })).items[0];
  assert.equal(denied?.blockedBy, "forbidden");
  assert.equal(
    await refused(
      worker.client.call("connection_disconnect", { instanceId, connectionId: first.connectionId }),
    ),
    "forbidden",
  );
  await done(root.call("connection_disconnect", { instanceId, connectionId: first.connectionId }));
  assert.equal(await first.closed, 1000);
  assert.equal((await providers(root)).items[0]?.selectedConnectionId, second.connectionId);
  const third = await provider(t, core);
  await done(root.call("connection_disconnect", { instanceId, connectionId: third.connectionId }));
  assert.equal(await third.closed, 1000);
  view = (await providers(root)).items[0];
  assert.equal(view?.admittedConnections, 1);
  assert.equal(view?.selectedConnectionId, null, "no older socket is promoted as a fallback");
  assert.equal(core.provider("factory"), undefined);
});

test("busy guards span Provider RPC gaps and the complete Actor Tool invocation", async (t) => {
  const { core, root } = await fixture(t);
  const otherRoot = await core.client(core.root);
  const incoming = held<Request>();
  const peer = await provider(t, core, "factory", (request) => incoming.resolve(request));
  const factory = core.provider("factory");
  assert.ok(factory);
  const described = held<void>();
  const releaseDescription = held<void>();
  const describe = factory.describe.bind(factory);
  t.mock.method(factory, "describe", async () => {
    const value = await describe();
    described.resolve();
    await releaseDescription.promise;
    return value;
  });
  const pending = done(
    root.call("actor_create", {
      name: "held",
      purpose: "Owned model-free creation",
      execution: { providerId: "factory", config: {} },
    }),
  );
  const description = await incoming.promise;
  assert.equal(description.method, "provider.describe");
  peer.reply(description, { configSchema: { type: "object" } });
  await described.promise;
  const row = (await page(otherRoot, { connectionId: peer.connectionId })).items[0];
  assert.equal(row?.pendingFactoryRequests, 0);
  assert.equal(row?.activeCreations, 1);
  assert.equal(row?.blockedBy, "busy");
  const instanceId = (await status(otherRoot)).instanceId;
  assert.equal(
    await refused(
      otherRoot.call("connection_disconnect", { instanceId, connectionId: peer.connectionId }),
    ),
    "conflict",
  );
  const caller = (await page(otherRoot, { actorId: core.rootId })).items.find(
    (entry) => entry.activeInvocations > 0 && entry.blockedBy === "busy",
  );
  assert.ok(caller);
  assert.equal(
    await refused(
      otherRoot.call("connection_disconnect", { instanceId, connectionId: caller.connectionId }),
    ),
    "conflict",
  );
  releaseDescription.resolve();
  await until("owned Provider receives its create request", () => peer.requests.length === 2);
  const creation = peer.requests[1];
  assert.ok(creation);
  const heldRow = (await page(otherRoot, { connectionId: peer.connectionId })).items[0];
  assert.equal(heldRow?.pendingFactoryRequests, 1);
  assert.equal(heldRow?.activeCreations, 1);
  peer.reply(creation, { actorId: creation.params.actorId });
  assert.equal((await pending).execution.status, "ready");
  const finished = (await page(otherRoot, { connectionId: peer.connectionId })).items[0];
  assert.equal(finished?.activeCreations, 0);
  assert.equal(finished?.canDisconnect, true);
});

test("closing is atomic with dispatch; close and audit uncertainty never become success or retry", async (t) => {
  const { core, root, make } = await fixture(t);
  const worker = await make("worker");
  const peer = await socket(t, core, { actorId: worker.id, credential: worker.credential });
  const entry = core.org.connections.get(peer.connectionId);
  assert.ok(entry);
  const instanceId = (await status(root)).instanceId;
  let reentrant: ReturnType<typeof core.org.invoke> | undefined;
  let attempts = 0;
  const close = t.mock.method(entry.control, "detach", () => {
    attempts += 1;
    assert.equal(entry.state, "closing");
    assert.throws(() => core.org.available(worker.id, peer.connectionId), /closing or ended/);
    reentrant = core.org.invoke(
      worker.id,
      "work_create",
      { ownerID: worker.id, goal: "MUST_NOT_COMMIT" },
      { ...invocation, connectionId: peer.connectionId },
    );
    throw new Error("CLOSE_SECRET_SENTINEL");
  });
  await assert.rejects(
    root.call("connection_disconnect", { instanceId, connectionId: peer.connectionId }),
    /write outcome may be unknown/,
  );
  assert.ok(reentrant);
  assert.equal(await refused(reentrant), "conflict");
  assert.equal((await done(root.call("work_list"))).items.length, 0);
  assert.equal(
    (await page(root, { connectionId: peer.connectionId })).items[0]?.blockedBy,
    "closing",
  );
  assert.equal(
    await refused(
      root.call("connection_disconnect", { instanceId, connectionId: peer.connectionId }),
    ),
    "conflict",
  );
  assert.equal(attempts, 1);
  close.mock.restore();
  peer.channel.close();

  const afterClose = await socket(t, core, { actorId: worker.id, credential: worker.credential });
  const next = core.org.connections.get(afterClose.connectionId);
  assert.ok(next);
  const detach = next.control.detach;
  t.mock.method(next.control, "detach", () => {
    detach();
    throw new Error("AFTER_CLOSE_SENTINEL");
  });
  await assert.rejects(
    root.call("connection_disconnect", { instanceId, connectionId: afterClose.connectionId }),
    /write outcome may be unknown/,
  );
  assert.equal(await afterClose.closed, 1000);
  assert.equal((await page(root, { connectionId: afterClose.connectionId })).items.length, 0);

  const afterAudit = await socket(t, core, { actorId: worker.id, credential: worker.credential });
  const append = t.mock.method(core.store.audit, "append", () => {
    throw new Error("AUDIT_SECRET_SENTINEL");
  });
  await assert.rejects(
    root.call("connection_disconnect", { instanceId, connectionId: afterAudit.connectionId }),
    /write outcome may be unknown/,
  );
  append.mock.restore();
  assert.equal(await afterAudit.closed, 1000);
  assert.equal((await page(root, { connectionId: afterAudit.connectionId })).items.length, 0);
  assert.equal(
    await refused(
      root.call("connection_disconnect", { instanceId, connectionId: afterAudit.connectionId }),
    ),
    "not_found",
  );
  const observed = JSON.stringify(await status(root));
  for (const secret of [
    "CLOSE_SECRET_SENTINEL",
    "AFTER_CLOSE_SENTINEL",
    "AUDIT_SECRET_SENTINEL",
    "MUST_NOT_COMMIT",
  ])
    assert.equal(observed.includes(secret), false);
});

test("pending factory RPCs block detach independently and closing refuses a new creation span", async (t) => {
  const { core, root } = await fixture(t);
  const incoming = held<Request>();
  const peer = await provider(t, core, "factory", (request) => incoming.resolve(request));
  const client = core.provider("factory");
  assert.ok(client);
  const pending = client.describe();
  const request = await incoming.promise;
  const row = (await page(root, { connectionId: peer.connectionId })).items[0];
  assert.equal(row?.activeCreations, 0);
  assert.equal(row?.pendingFactoryRequests, 1);
  assert.equal(row?.blockedBy, "busy");
  const instanceId = (await status(root)).instanceId;
  assert.equal(
    await refused(
      root.call("connection_disconnect", { instanceId, connectionId: peer.connectionId }),
    ),
    "conflict",
  );
  peer.reply(request, { configSchema: { type: "object" } });
  await pending;
  const entry = core.org.connections.get(peer.connectionId);
  assert.ok(entry);
  const detach = entry.control.detach;
  t.mock.method(entry.control, "detach", () => {
    assert.throws(() => client.holdCreation(), /closing or ended/);
    detach();
  });
  await done(root.call("connection_disconnect", { instanceId, connectionId: peer.connectionId }));
  assert.equal(await peer.closed, 1000);
});

test("private Message success, refusal, validation, storage and postcommit audit failures emit no diagnostic events", async (t) => {
  const { core, root, make } = await fixture(t);
  const sender = await make("sender");
  const recipient = await make("recipient");
  const observer = await make("unrelated");
  const recorded = t.mock.method(core.org.diagnostics, "record");
  const sent = await done(
    sender.client.call("message_send", {
      recipientID: recipient.id,
      text: "PRIVATE_BODY_SENTINEL",
    }),
  );
  await done(recipient.client.call("message_get", { messageID: sent.messageID }));
  await done(recipient.client.call("message_list", {}));
  assert.equal(
    await refused(observer.client.call("message_get", { messageID: sent.messageID })),
    "not_found",
  );
  assert.equal(
    await refused(
      sender.client.call("message_send", {
        recipientID: "unknown",
        text: "PRIVATE_REFUSAL_SENTINEL",
      }),
    ),
    "not_found",
  );
  for (const name of ["message_send", "message_get", "message_list"])
    assert.equal(
      await refused(sender.client.call(name, { invalid: "PRIVATE_VALIDATION_SENTINEL" })),
      "invalid",
    );
  const save = t.mock.method(core.store.workspace.messages, "save", () => {
    throw new Error("PRIVATE_STORAGE_SENTINEL");
  });
  await assert.rejects(
    sender.client.call("message_send", {
      recipientID: recipient.id,
      text: "PRIVATE_NOT_COMMITTED",
    }),
    /write outcome may be unknown/,
  );
  save.mock.restore();
  const audit = t.mock.method(core.store.audit, "append", () => {
    throw new Error("PRIVATE_AUDIT_SENTINEL");
  });
  await assert.rejects(
    sender.client.call("message_send", {
      recipientID: recipient.id,
      text: "PRIVATE_COMMITTED_SENTINEL",
    }),
    /write outcome may be unknown/,
  );
  audit.mock.restore();
  assert.equal(
    (await done(recipient.client.call("message_list", {}))).items.length,
    2,
    "postcommit failure is not replayed",
  );
  assert.equal(
    recorded.mock.callCount(),
    0,
    "suppression occurs before any recorder call or correlation fields",
  );
  assert.deepEqual((await status(observer.client)).diagnostics.items, []);
  assert.equal(await refused(root.call("UNKNOWN_OPERATION_SECRET", {})), "not_found");
  assert.equal(recorded.mock.callCount(), 0);
  assert.equal(
    await refused(observer.client.call("actor_close", { actor: sender.id })),
    "forbidden",
  );
  const publicEvents = (await status(observer.client)).diagnostics.items;
  assert.equal(
    publicEvents.length,
    1,
    "unrelated nonprivate failure is an instrumented positive control",
  );
  assert.equal(publicEvents[0]?.operation, "actor_close");
  const encoded = JSON.stringify(publicEvents);
  for (const secret of [
    "PRIVATE_",
    "UNKNOWN_OPERATION_SECRET",
    sender.id,
    recipient.id,
    sent.messageID,
    credential,
    hash,
  ])
    assert.equal(encoded.includes(secret), false);
});

test("diagnostics retain only 100 whitelisted fixed observations and cannot break business commits", async (t) => {
  const { core, root, make } = await fixture(t);
  const worker = await make("worker");
  let failClock = false;
  const observed = diagnostics(() => {
    if (failClock) throw new Error("CLOCK_SECRET");
    return "2026-10-31T00:00:00.000Z";
  });
  const event = {
    code: "operation_failed" as const,
    stage: "invocation" as const,
    outcome: "unknown" as const,
    actorId: worker.id,
    operation: "work_create",
    secret: "CONFIG_PROMPT_CREDENTIAL_SENTINEL",
  };
  for (let i = 0; i < 105; i++) observed.record(event);
  assert.equal(observed.read(2).items.length, 2);
  assert.deepEqual(
    { ...observed.read(100), items: [] },
    { items: [], capacity: 100, retained: 100, dropped: 5, scope: "this_run" },
  );
  assert.equal(JSON.stringify(observed.read(100)).includes(event.secret), false);
  for (const operation of ["message_send", "message_get", "message_list"])
    observed.record({ ...event, operation });
  assert.equal(observed.read(100).dropped, 5);
  failClock = true;
  assert.doesNotThrow(() => observed.record(event));
  failClock = false;
  assert.doesNotThrow(() =>
    observed.record({
      ...event,
      get actorId(): string {
        throw new Error("GETTER_SECRET");
      },
    }),
  );
  failClock = true;
  // An observer's failing clock must not turn an already committed write into failure.
  t.mock.method(core.org.diagnostics, "record", observed.record);
  const work = await done(
    root.call("work_create", { ownerID: worker.id, title: "Committed fixture" }),
  );
  const append = t.mock.method(core.store.audit, "append", () => {
    throw new Error("POSTCOMMIT_SECRET");
  });
  await assert.rejects(
    root.call("work_create", { ownerID: worker.id, title: "Committed despite audit" }),
    /write outcome may be unknown/,
  );
  append.mock.restore();
  assert.equal(
    (await done(root.call("work_get", { ticketID: work.ticketID }))).title,
    "Committed fixture",
  );
  assert.equal((await done(root.call("work_list"))).items.length, 2);
});

test("untrusted admission and Provider failures expose fixed facts without attempted identity or remote content", async (t) => {
  const { core, root } = await fixture(t);
  const url = new URL(CONNECTION_PATH, core.url);
  url.protocol = "ws:";
  const raw = await dial(url);
  t.after(() => raw.close());
  await assert.rejects(
    establish(raw, {
      actorId: "ATTEMPTED_IDENTITY_SENTINEL",
      credential: "REJECTED_CREDENTIAL_SENTINEL",
    }),
  );
  const rejected = (await status(root)).diagnostics.items.find(
    (event) => event.code === "admission_refused",
  );
  assert.ok(rejected);
  for (const key of ["actorId", "providerId", "connectionId", "operation"])
    assert.equal(Object.hasOwn(rejected, key), false);
  const incoming = held<Request>();
  const peer = await provider(t, core, "factory", (request) => incoming.resolve(request));
  const pending = done(
    root.call("actor_create", {
      name: "bad-provider",
      purpose: "Owned fixture",
      execution: { providerId: "factory", config: { prompt: "NATIVE_PROMPT_SENTINEL" } },
    }),
  );
  const request = await incoming.promise;
  peer.reply(request, {
    configSchema: { type: "INVALID_SCHEMA_SENTINEL", default: "PROVIDER_DEFAULT_SENTINEL" },
  });
  assert.equal((await pending).execution.status, "failed");
  peer.channel.send("INVALID_JSON_REMOTE_ERROR_SECRET");
  await until("fixed Provider protocol observation is recorded", async () =>
    (await status(root)).diagnostics.items.some((event) => event.code === "protocol_invalid"),
  );
  const observed = await status(root);
  assert.ok(
    observed.diagnostics.items.some(
      (event) => event.code === "provider_unavailable" && event.providerId === "factory",
    ),
  );
  assert.ok(
    observed.diagnostics.items.some(
      (event) =>
        event.code === "protocol_invalid" &&
        event.stage === "transport" &&
        event.connectionId === peer.connectionId,
    ),
  );
  const unknown = done(
    root.call("actor_create", {
      name: "unknown-provider",
      purpose: "Owned fixture",
      execution: { providerId: "factory", config: {} },
    }),
  );
  await until("second owned description request", () => peer.requests.length === 2);
  const descriptionRequest = peer.requests[1];
  assert.ok(descriptionRequest);
  peer.reply(descriptionRequest, { configSchema: { type: "object" } });
  await until("owned creation request", () => peer.requests.length === 3);
  const creationRequest = peer.requests[2];
  assert.ok(creationRequest);
  peer.reply(creationRequest, {
    actorId: "REMOTE_NATIVE_ID_SENTINEL",
    prompt: "REMOTE_PROMPT_SENTINEL",
  });
  assert.equal((await unknown).execution.status, "unknown");
  assert.ok(
    (await status(root)).diagnostics.items.some(
      (event) => event.code === "execution_outcome_unknown" && event.outcome === "unknown",
    ),
  );
  await done(
    root.call("actor_create", {
      name: "unavailable",
      purpose: "Owned fixture",
      execution: { providerId: "UNCONFIGURED_PROVIDER_SENTINEL", config: {} },
    }),
  );
  const unavailable = (await status(root)).diagnostics.items.find(
    (event) =>
      event.code === "provider_unavailable" &&
      event.outcome === "not_sent" &&
      event.providerId === undefined,
  );
  assert.ok(unavailable);
  const encoded = JSON.stringify(await status(root));
  for (const secret of [
    "SENTINEL",
    "REMOTE_ERROR_SECRET",
    credential,
    hash,
    "credentialHash",
    "configSchema",
  ])
    assert.equal(encoded.includes(secret), false);
});

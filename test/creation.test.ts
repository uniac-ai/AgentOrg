/** Unified Actor creation through real Hub MCP and an independently connected fake Provider. */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { z } from "zod";
import { connectClient } from "../src/actor/index.ts";
import { CONNECTION_PATH, establish } from "../src/connection/index.ts";
import { type Channel, dial } from "../src/network/index.ts";
import { done, startCore, until } from "./harness.ts";

interface Request {
  id: string;
  method: string;
  params: { actorId: string; credential: string; config: Record<string, unknown> };
}

async function fixture(
  t: TestContext,
  options: {
    schema?: Record<string, unknown>;
    create?: (request: Request, channel: Channel) => void;
    describe?: (request: Request, channel: Channel) => void;
    timeoutMs?: number;
    defaultTimeouts?: boolean;
  } = {},
) {
  const credential = "sentinel-factory-admission";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
  const core = await startCore({
    providers: [{ providerId: "factory", credentialHash: Buffer.from(digest).toString("hex") }],
    ...(options.defaultTimeouts ? {} : { timeoutMs: options.timeoutMs ?? 5000 }),
  });
  t.after(() => core.close());
  const url = new URL(CONNECTION_PATH, core.url);
  url.protocol = "ws:";
  const raw = await dial(url);
  t.after(() => raw.close());
  const { channel } = await establish(raw, { providerId: "factory", credential });
  const requests: Request[] = [];
  const reply = (request: Request, value: object) =>
    channel.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value }));
  channel.listen(
    (text) => {
      const request = JSON.parse(text) as Request;
      requests.push(request);
      if (request.method === "provider.describe") {
        if (options.describe) options.describe(request, channel);
        else reply(request, { configSchema: options.schema ?? z.toJSONSchema(z.strictObject({})) });
      } else if (options.create) options.create(request, channel);
      else reply(request, { actorId: request.params.actorId });
    },
    () => {},
  );
  const root = await core.client(core.root);
  return { core, root, requests, channel, reply };
}

const input = (name: string, config: Record<string, unknown> = {}) => ({
  name,
  purpose: "Perform the requested work",
  execution: { providerId: "factory", config },
});

test("no-execution creation keeps its result shape and invalid execution syntax allocates no Actor", async (t) => {
  const { core, root, requests } = await fixture(t);
  const ordinary = await done(root.call("actor_create", { name: "ordinary", purpose: "Work" }));
  assert.deepEqual(Object.keys(ordinary).sort(), ["actor", "credential"]);
  const before = core.org.registry.open().length;
  for (const execution of [
    { providerId: "factory" },
    { providerId: "factory", config: [] },
    { providerId: "factory", config: null },
    { providerId: "factory", config: {}, extra: true },
  ]) {
    assert.equal(
      (await root.call("actor_create", { name: "invalid", purpose: "Work", execution })).state,
      "refused",
    );
  }
  assert.equal(core.org.registry.open().length, before);
  assert.equal(requests.length, 0);
});

test("Provider ready is returned while the new Actor is offline, with private bootstrap separate from config", async (t) => {
  const { core, root, requests } = await fixture(t);
  const value = await done(root.call("actor_create", input("offline")));
  assert.deepEqual(value.execution, { providerId: "factory", status: "ready" });
  assert.equal(value.actor.online, false);
  const create = requests.find((request) => request.method === "provider.createActor");
  assert.ok(create);
  assert.deepEqual(create.params, {
    actorId: value.actor.id,
    credential: value.credential,
    config: {},
  });
  assert.equal((await core.org.registry.byCredential(value.credential))?.id, value.actor.id);
  assert.doesNotMatch(JSON.stringify(requests), /sentinel-factory-admission/);
  assert.ok(!JSON.stringify(value.actor).includes(value.credential));
});

test("the provisioned Actor uses Hub MCP without a reverse server while its Provider reply is held", async (t) => {
  let launched!: (request: Request) => void;
  const launch = new Promise<Request>((resolve) => {
    launched = resolve;
  });
  const { core, root, reply } = await fixture(t, { create: (request) => launched(request) });
  let returned = false;
  const creating = done(root.call("actor_create", input("early"))).then((value) => {
    returned = true;
    return value;
  });
  const request = await launch;
  assert.equal(core.org.registry.get(request.params.actorId)?.manager, core.rootId);
  const actor = await connectClient({
    url: core.url,
    actorId: request.params.actorId,
    credential: request.params.credential,
  });
  t.after(() => actor.close());
  assert.equal((await actor.call("team", { depth: 0 })).state, "done");
  assert.equal(
    (await actor.available()).length,
    10,
    "the Provider connection adds no Actor-facing Tool",
  );
  await until("the new Actor is connected before the Provider replies", () =>
    core.org.connections.connected(request.params.actorId),
  );
  assert.equal(returned, false);
  reply(request, { actorId: request.params.actorId });
  const value = await creating;
  assert.equal(value.actor.online, true);
  assert.equal(value.execution.status, "ready");
});

test("schema or descriptor failures retain the Actor and its valid credential without launching", async (t) => {
  const schema = z.toJSONSchema(z.strictObject({ project: z.string() }));
  const { core, root, requests } = await fixture(t, { schema });
  const value = await done(root.call("actor_create", input("invalid-config")));
  assert.equal(value.execution.status, "failed");
  assert.equal(value.execution.error.code, "invalid");
  assert.deepEqual(
    requests.map((request) => request.method),
    ["provider.describe"],
  );
  const actor = await connectClient({
    url: core.url,
    actorId: value.actor.id,
    credential: value.credential,
  });
  t.after(() => actor.close());
  assert.equal(
    (await actor.call("work_create", { ownerID: core.rootId, title: "Independent Actor" })).state,
    "done",
  );
  assert.equal(core.org.registry.get(value.actor.id)?.closed_at, null);
});

test("valid Zod configuration reaches the Provider unchanged and creates a direct report of the caller", async (t) => {
  const { core, root, requests } = await fixture(t, {
    schema: z.toJSONSchema(z.strictObject({ project: z.string() })),
  });
  const managerValue = await done(
    root.call("actor_create", { name: "lead", purpose: "Manage work" }),
  );
  const manager = await core.client(managerValue.credential);
  const value = await done(manager.call("actor_create", input("report", { project: "example" })));
  assert.equal(value.actor.manager, managerValue.actor.id);
  assert.equal(value.execution.status, "ready");
  assert.deepEqual(requests[1]?.params.config, { project: "example" });
});

for (const failure of ["refusal", "disconnect", "malformed", "timeout"] as const) {
  test(`a ${failure} after launch returns the Actor and separate execution outcome without replay`, async (t) => {
    let held: Request | undefined;
    const { core, root, requests, reply } = await fixture(t, {
      timeoutMs: failure === "timeout" ? 500 : 5000,
      create: (request, channel) => {
        held = request;
        if (failure === "refusal")
          channel.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32000,
                message: request.params.credential,
                data: { code: "PROVISIONING_FAILED", config: request.params.config },
              },
            }),
          );
        else if (failure === "disconnect") channel.close();
        else if (failure === "malformed")
          reply(request, { actorId: "wrong-actor", nativeHandle: "sentinel-native-resource" });
      },
    });
    const value = await done(root.call("actor_create", input(`case-${failure}`)));
    assert.ok(held);
    assert.equal(value.execution.status, failure === "refusal" ? "failed" : "unknown");
    assert.equal(
      value.execution.error.code,
      failure === "refusal" ? "PROVISIONING_FAILED" : "PROVISIONING_UNKNOWN",
    );
    assert.ok(!JSON.stringify(value.execution).includes(value.credential));
    assert.doesNotMatch(JSON.stringify(value.execution), /sentinel|wrong-actor/);
    assert.equal(core.org.registry.get(value.actor.id)?.closed_at, null);
    assert.equal((await core.org.registry.byCredential(value.credential))?.id, value.actor.id);
    if (failure === "timeout") reply(held, { actorId: held.params.actorId });
    assert.equal((await root.call("team")).state, "done");
    assert.deepEqual(
      requests.map((request) => request.method),
      ["provider.describe", "provider.createActor"],
    );
  });
}

test("an explicitly shorter caller timeout is preserved without cancelling or replaying execution", async (t) => {
  let launched!: (request: Request) => void;
  const launch = new Promise<Request>((resolve) => {
    launched = resolve;
  });
  const { core, root, requests, reply } = await fixture(t, {
    defaultTimeouts: true,
    create: (request) => launched(request),
  });
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let guard: ReturnType<typeof setTimeout> | undefined;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    const creating = root.call("actor_create", input("short-budget"), { timeoutMs: 1000 });
    const refused = assert.rejects(creating, /timed out/i);
    const request = await Promise.race([
      launch,
      new Promise<never>((_resolve, reject) => {
        guard = realSetTimeout(
          () => reject(new Error("never happened: execution was launched")),
          5000,
        );
      }),
    ]);
    t.mock.timers.tick(1000);
    await refused;
    assert.equal(core.org.registry.get(request.params.actorId)?.closed_at, null);
    reply(request, { actorId: request.params.actorId });
    assert.equal((await root.call("team")).state, "done");
    assert.deepEqual(
      requests.map((request) => request.method),
      ["provider.describe", "provider.createActor"],
    );
  } finally {
    realClearTimeout(guard);
    t.mock.timers.reset();
  }
});

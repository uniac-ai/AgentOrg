/** The Hub factory client against a real socket with an independently implemented Provider peer. */

import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { type TestContext, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { connectClient } from "../src/actor/index.ts";
import { accept, CONNECTION_PATH, establish, type Identity } from "../src/connection/index.ts";
import { organization } from "../src/domain/index.ts";
import { providers } from "../src/domain/providers.ts";
import { Channel, dial } from "../src/network/channel.ts";
import { listen } from "../src/network/listener.ts";
import { ProviderClient, ProviderError } from "../src/provider/index.ts";
import { startCore } from "../src/server/index.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";

type Request = { jsonrpc: string; id: string; method: string; params: Record<string, unknown> };

async function provider(t: TestContext, answer: (request: Request, peer: WebSocket) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const accepted = once(server, "connection");
  const peer = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const [socket] = (await accepted) as [WebSocket];
  const channel = new Channel({
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  });
  socket.on("message", (text) => channel.receive(String(text)));
  socket.on("close", () => channel.closed());
  await once(peer, "open");
  const requests: Request[] = [];
  const replies: Record<string, unknown>[] = [];
  peer.on("message", (text) => {
    const message = JSON.parse(String(text));
    if (typeof message.method === "string") {
      requests.push(message);
      answer(message, peer);
    } else {
      replies.push(message);
    }
  });
  t.after(async () => {
    peer.terminate();
    socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { channel, peer, requests, replies };
}

const result = (peer: WebSocket, request: Request, value: unknown) =>
  peer.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value }));

test("the Provider factory uses the accepted socket and keeps Actor bootstrap separate from config", async (t) => {
  const schema = {
    type: "object",
    properties: { label: { type: "string", default: "first" } },
    additionalProperties: false,
  };
  const fake = await provider(t, (request, peer) =>
    result(
      peer,
      request,
      request.method === "provider.describe"
        ? { configSchema: schema }
        : { actorId: request.params.actorId },
    ),
  );
  const client = new ProviderClient(fake.channel);
  assert.deepEqual(await client.describe(), { configSchema: schema });
  const config = {};
  assert.deepEqual(
    await client.createActor({
      actorId: "actor-a",
      credential: "sentinel-actor-bootstrap",
      config,
    }),
    { actorId: "actor-a" },
  );
  assert.deepEqual(config, {});
  assert.deepEqual(
    fake.requests.map(({ method, params }) => ({ method, params })),
    [
      { method: "provider.describe", params: {} },
      {
        method: "provider.createActor",
        params: { actorId: "actor-a", credential: "sentinel-actor-bootstrap", config: {} },
      },
    ],
  );
});

test("creation requires an object config and preserves omission of the bootstrap credential", async (t) => {
  const fake = await provider(t, (request, peer) => result(peer, request, { actorId: "actor-a" }));
  const client = new ProviderClient(fake.channel);
  for (const invalid of [
    { actorId: "actor-a" },
    { actorId: "actor-a", config: null },
    { actorId: "actor-a", config: [] },
    { actorId: "actor-a", config: {}, credential: undefined },
    { actorId: "actor-a", config: {}, providerCredential: "sentinel-provider" },
  ]) {
    await assert.rejects(
      client.createActor(invalid as Parameters<ProviderClient["createActor"]>[0]),
      { code: "invalid", rpcCode: -32602 },
    );
  }
  assert.equal(fake.requests.length, 0);
  assert.deepEqual(await client.createActor({ actorId: "actor-a", config: {} }), {
    actorId: "actor-a",
  });
  assert.equal(Object.hasOwn(fake.requests[0]?.params ?? {}, "credential"), false);
});

test("descriptions validate the schema and create results name only the requested Actor", async (t) => {
  const fake = await provider(t, (request, peer) => {
    if (request.method === "provider.describe") {
      result(peer, request, { configSchema: { type: "sentinel-invalid-schema" } });
    } else {
      result(peer, request, { actorId: "actor-other", nativeId: "sentinel-native-handle" });
    }
  });
  const client = new ProviderClient(fake.channel);
  await assert.rejects(client.describe(), { code: "error", rpcCode: -32603 });
  await assert.rejects(client.createActor({ actorId: "actor-a", config: {} }), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "PROVISIONING_UNKNOWN");
    assert.doesNotMatch(JSON.stringify(error), /sentinel|actor-other/);
    return true;
  });
});

test("unsupported schema metadata never exposes the Provider's schema text in diagnostics", async (t) => {
  const fake = await provider(t, (request, peer) =>
    result(peer, request, {
      configSchema: { $schema: "sentinel-provider-private-schema", type: "object" },
    }),
  );
  const client = new ProviderClient(fake.channel);
  await assert.rejects(client.describe(), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "error");
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /sentinel/);
    return true;
  });
});

test("Provider descriptions accept actual Zod 2020-12 configuration schemas", async (t) => {
  const configSchema = z.toJSONSchema(
    z.object({ workspace: z.string(), pair: z.tuple([z.string(), z.number()]) }).strict(),
  );
  const fake = await provider(t, (request, peer) => result(peer, request, { configSchema }));
  const client = new ProviderClient(fake.channel);
  assert.deepEqual(await client.describe(), { configSchema });
});

test("concurrent requests correlate out of order while opposite-direction IDs stay independent", async (t) => {
  const held: Request[] = [];
  const fake = await provider(t, (request, peer) => {
    held.push(request);
    if (held.length !== 2) return;
    peer.send(
      JSON.stringify({ jsonrpc: "2.0", id: held[0]?.id, method: "not-a-hub-method", params: {} }),
    );
    result(peer, held[1] as Request, { actorId: held[1]?.params.actorId });
    result(peer, held[0] as Request, { actorId: held[0]?.params.actorId });
  });
  const client = new ProviderClient(fake.channel);
  assert.deepEqual(
    await Promise.all([
      client.createActor({ actorId: "actor-first", config: {} }),
      client.createActor({ actorId: "actor-second", config: {} }),
    ]),
    [{ actorId: "actor-first" }, { actorId: "actor-second" }],
  );
  // The Provider's first request was sent before the creation replies; observe its answer.
  while (fake.replies.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.replies[0], {
    jsonrpc: "2.0",
    id: held[0]?.id,
    error: { code: -32601, message: "Method not found" },
  });
});

test("Provider errors preserve stable semantic and numeric codes while withholding remote text/data", async (t) => {
  const codes = ["CREATION_CONFLICT", "PROVISIONING_UNKNOWN", "PROVISIONING_FAILED", "invalid"];
  const fake = await provider(t, (request, peer) =>
    peer.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32017,
          message: "sentinel-bootstrap in provider diagnostic",
          data: {
            code: (request.params.config as Record<string, unknown>).code,
            private: "sentinel-native-resource",
          },
        },
      }),
    ),
  );
  const client = new ProviderClient(fake.channel);
  for (const code of codes) {
    await assert.rejects(
      client.createActor({
        actorId: "actor-a",
        credential: "sentinel-bootstrap",
        config: { code },
      }),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.code, code);
        assert.equal(error.rpcCode, -32017);
        assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /sentinel/);
        return true;
      },
    );
  }
});

test("a lost socket leaves creation unknown and sends no cancellation", async (t) => {
  const fake = await provider(t, (_request, peer) => peer.close());
  const client = new ProviderClient(fake.channel);
  await assert.rejects(client.createActor({ actorId: "actor-a", config: {} }), {
    code: "PROVISIONING_UNKNOWN",
  });
  await assert.rejects(client.describe(), { code: "unavailable" });
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ["provider.createActor"],
  );
});

test("creation on an already ended connection is known not to have been sent", async (t) => {
  const fake = await provider(t, () => assert.fail("creation must not reach the Provider"));
  const client = new ProviderClient(fake.channel);
  client.close();
  await assert.rejects(client.createActor({ actorId: "actor-a", config: {} }), {
    code: "unavailable",
    rpcCode: -32000,
  });
  assert.equal(fake.requests.length, 0);
});

test("a timed-out creation remains unknown without cancelling the Provider's held operation", async (t) => {
  const held: Request[] = [];
  const fake = await provider(t, (request) => held.push(request));
  const client = new ProviderClient(fake.channel, { timeoutMs: 10 });
  await assert.rejects(client.createActor({ actorId: "actor-a", config: {} }), {
    code: "PROVISIONING_UNKNOWN",
  });
  assert.equal(held.length, 1);
  assert.equal(held[0]?.method, "provider.createActor");
  result(fake.peer, held[0] as Request, { actorId: "actor-a" });
  assert.equal(fake.requests.length, 1);
});

test("admission keeps identical Actor/Provider IDs separate and invokes Provider methods on its initiating socket", async (t) => {
  const providerCredential = "sentinel-provider-admission";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(providerCredential));
  const configured = providers([
    {
      providerId: "same-id",
      credentialHash: Buffer.from(hash).toString("hex"),
    },
  ]);
  const admitted: { actorId?: string; providerId?: string }[] = [];
  let connected: (client: ProviderClient) => void;
  const factory = new Promise<ProviderClient>((resolve) => {
    connected = resolve;
  });
  const listener = await listen({
    port: 0,
    path: CONNECTION_PATH,
    channel: (channel) =>
      accept(
        channel,
        {
          admit: async (identity) =>
            "actorId" in identity
              ? identity.actorId === "same-id" && identity.credential === "sentinel-actor-admission"
              : configured.admit(identity.providerId, identity.credential),
        },
        (connection) => {
          admitted.push(connection.principal);
          if ("providerId" in connection.principal) {
            connected(new ProviderClient(connection.channel));
          }
        },
      ),
  });
  t.after(() => listener.close());
  async function open(identity: Identity) {
    const url = new URL(CONNECTION_PATH, listener.url);
    url.protocol = "ws:";
    const raw = await dial(url);
    t.after(() => raw.close());
    return establish(raw, identity);
  }
  await assert.rejects(open({ providerId: "same-id", credential: "sentinel-actor-admission" }));
  await assert.rejects(open({ actorId: "same-id", credential: providerCredential }));
  await assert.rejects(open({ providerId: "same-id" }));
  assert.equal(admitted.length, 0);
  const actor = await open({ actorId: "same-id", credential: "sentinel-actor-admission" });
  const provider = await open({ providerId: "same-id", credential: providerCredential });
  assert.notEqual(actor.connectionId, provider.connectionId);
  assert.deepEqual(admitted, [{ actorId: "same-id" }, { providerId: "same-id" }]);
  const called: Request[] = [];
  provider.channel.listen(
    (text) => {
      const request = JSON.parse(text) as Request;
      called.push(request);
      provider.channel.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "provider.describe"
              ? { configSchema: { type: "object", additionalProperties: false } }
              : { actorId: request.params.actorId },
        }),
      );
    },
    () => {},
  );
  const client = await factory;
  assert.deepEqual(await client.describe(), {
    configSchema: { type: "object", additionalProperties: false },
  });
  assert.deepEqual(
    await client.createActor({
      actorId: "new-actor",
      credential: "sentinel-bootstrap",
      config: {},
    }),
    { actorId: "new-actor" },
  );
  assert.deepEqual(
    called.map((request) => request.method),
    ["provider.describe", "provider.createActor"],
  );
  assert.doesNotMatch(JSON.stringify(called), /sentinel-provider-admission/);
});

test("the assembled Hub keeps a same-ID Provider usable after revoking every Actor connection", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const registry = organization(store).registry;
  const { root, credential: rootCredential } = await registry.createRoot();
  const { actor, credential } = await registry.create(root.id, "worker", "Receive work");
  const providerCredential = "sentinel-independent-provider";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(providerCredential));
  const hub = await startCore(store, {
    port: 0,
    providers: [
      {
        providerId: actor.id,
        credentialHash: Buffer.from(hash).toString("hex"),
      },
    ],
  });
  t.after(() => hub.close());
  const url = new URL(CONNECTION_PATH, hub.url);
  url.protocol = "ws:";
  const socket = await dial(url);
  t.after(() => socket.close());
  await assert.rejects(establish(socket, { providerId: actor.id, credential }));
  await assert.rejects(
    connectClient({ url: hub.url, actorId: actor.id, credential: providerCredential }),
  );
  const providerSocket = await dial(url);
  t.after(() => providerSocket.close());
  const admitted = await establish(providerSocket, {
    providerId: actor.id,
    credential: providerCredential,
  });
  const calls: Request[] = [];
  admitted.channel.listen(
    (text) => {
      const request = JSON.parse(text) as Request;
      calls.push(request);
      admitted.channel.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "provider.describe"
              ? { configSchema: { type: "object" } }
              : { actorId: request.params.actorId },
        }),
      );
    },
    () => {},
  );
  const rootClient = await connectClient({
    url: hub.url,
    actorId: root.id,
    credential: rootCredential,
  });
  t.after(() => rootClient.close());
  const actorClient = await connectClient({ url: hub.url, actorId: actor.id, credential });
  t.after(() => actorClient.close());
  assert.equal((await rootClient.call("actor_close", { actor: actor.id })).state, "done");
  await assert.rejects(actorClient.call("team"));
  const factory = hub.provider(actor.id);
  assert.ok(factory);
  assert.deepEqual(await factory.describe(), { configSchema: { type: "object" } });
  assert.deepEqual(await factory.createActor({ actorId: root.id, config: {} }), {
    actorId: root.id,
  });
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(calls), /sentinel-independent-provider/);
});

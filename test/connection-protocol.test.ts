/** Admission and independent MCP directions on actual Hub sockets. */

import assert from "node:assert/strict";
import { once } from "node:events";
import { type TestContext, test } from "node:test";
import { WebSocket } from "ws";
import { connectClient } from "../src/actor/index.ts";
import { CONNECTION_PATH, type Identity } from "../src/connection/index.ts";
import type { ActorLink } from "../src/domain/ports.ts";
import { CLOSE_REPLACED, CLOSE_REVOKED } from "../src/network/index.ts";
import { type Core, fakeActor, iface, startCore, until } from "./harness.ts";

interface Frame {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; data?: { code: string } };
}

/** A fake Actor controls its reverse replies while making its own requests on that same socket. */
async function peer(t: TestContext, core: Core, identity: Identity) {
  const socket = new WebSocket(`${core.url.replace("http", "ws")}${CONNECTION_PATH}`);
  const frames: Frame[] = [];
  const closed = once(socket, "close");
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  await once(socket, "open");
  const close = async () => {
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
    await closed;
  };
  t.after(close);
  const send = (frame: object) => socket.send(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  const take = async (description: string, accepts: (frame: Frame) => boolean) => {
    let found: Frame | undefined;
    await until(description, () => {
      const index = frames.findIndex(accepts);
      if (index < 0) return false;
      found = frames.splice(index, 1)[0];
      return true;
    });
    assert.ok(found);
    return found;
  };
  const request = async (method: string, params: object, id: string | number) => {
    send({ id, method, params });
    return take(
      `reply to ${method} (${typeof id} ${id})`,
      (frame) => frame.method === undefined && frame.id === id,
    );
  };
  const admitted = await request("connection.connect", identity, "admission");
  assert.deepEqual(Object.keys(admitted.result ?? {}), ["connectionId"]);
  assert.equal(typeof admitted.result?.connectionId, "string");
  return {
    close,
    send,
    request,
    next: (method: string) => take(`Hub request ${method}`, (frame) => frame.method === method),
    reply: (frame: Frame, result: object) => send({ id: frame.id, result }),
  };
}

type Peer = Awaited<ReturnType<typeof peer>>;

async function initializeCaller(actor: Peer) {
  const initialized = await actor.request(
    "initialize",
    {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "socket-test", version: "0" },
    },
    "caller-initialize",
  );
  assert.equal(initialized.error, undefined);
  actor.send({ method: "notifications/initialized" });
}

function initializeExposure(actor: Peer, request: Frame) {
  actor.reply(request, {
    protocolVersion: request.params?.protocolVersion,
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: "socket-test", version: "0" },
  });
}

const tools = (names: string[]) => ({
  tools: names.map((name) => ({ name, inputSchema: { type: "object" } })),
});

async function barrier(actor: Peer) {
  assert.deepEqual((await actor.request("ping", {}, "barrier")).result, {});
}

test("one socket keeps simultaneous bidirectional numeric IDs and distinct string IDs", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const actor = await peer(t, core, { actorId: core.rootId, credential: core.root });
  await initializeCaller(actor);
  initializeExposure(actor, await actor.next("initialize"));
  const listing = await actor.next("tools/list");
  assert.equal(listing.id, 1);

  // Hub is still waiting on numeric 1 while this Actor uses both numeric 1 and string "1".
  const [numeric, textual] = await Promise.all([
    actor.request("tools/list", {}, 1),
    actor.request("ping", {}, "1"),
  ]);
  assert.equal(numeric.id, 1);
  assert.ok(Array.isArray(numeric.result?.tools));
  assert.equal(textual.id, "1");
  assert.deepEqual(textual.result, {});
  assert.equal(core.org.connections.link(core.rootId), undefined);

  actor.reply(listing, tools(["receive"]));
  await until("the reverse response registers exposure", () =>
    core.org.connections.interfaces(core.rootId).some((each) => each.name === "receive"),
  );
  await barrier(actor);
});

test("caller omission leaves the delivery owner intact while an empty advertisement replaces it", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const worker = await core.connect(core.root, fakeActor([iface("receive")]));
  await until(
    "the worker owns delivery",
    () => core.org.connections.link(core.rootId) !== undefined,
  );
  const owner = core.org.connections.link(core.rootId);

  const caller = await peer(t, core, { actorId: core.rootId, credential: core.root });
  await initializeCaller(caller);
  const reverse = await caller.next("initialize");
  caller.send({ id: reverse.id, error: { code: -32601, message: "Method not found" } });
  await barrier(caller);
  assert.equal(core.org.connections.link(core.rootId), owner);
  await caller.close();
  assert.equal(core.org.connections.link(core.rootId), owner);
  assert.deepEqual(
    core.org.connections.interfaces(core.rootId).map((each) => each.name),
    ["receive"],
  );

  await core.connect(core.root, fakeActor([]));
  await until(
    "the explicit empty advertisement owns delivery",
    () => core.org.connections.link(core.rootId) !== owner && worker.ended === CLOSE_REPLACED,
  );
  assert.ok(core.org.connections.link(core.rootId));
  assert.deepEqual(core.org.connections.interfaces(core.rootId), []);
});

for (const delayed of ["initialize", "tools/list"] as const) {
  test(`an older delayed ${delayed} cannot replace a newer exposure owner`, async (t) => {
    const core = await startCore();
    t.after(() => core.close());
    const older = await peer(t, core, { actorId: core.rootId, credential: core.root });
    await initializeCaller(older);
    const initialization = await older.next("initialize");
    let listing: Frame | undefined;
    if (delayed === "tools/list") {
      initializeExposure(older, initialization);
      listing = await older.next("tools/list");
    }

    await core.connect(core.root, fakeActor([iface("current")]));
    await until("the newer advertisement is current", () =>
      core.org.connections.interfaces(core.rootId).some((each) => each.name === "current"),
    );
    const current = core.org.connections.link(core.rootId);
    if (delayed === "initialize") {
      initializeExposure(older, initialization);
      listing = await older.next("tools/list");
    }
    assert.ok(listing);
    older.reply(listing, tools(["stale"]));
    await barrier(older);
    older.send({ method: "notifications/tools/list_changed" });
    older.reply(await older.next("tools/list"), tools(["stale_changed"]));
    await barrier(older);
    assert.equal(core.org.connections.link(core.rootId), current);
    assert.deepEqual(
      core.org.connections.interfaces(core.rootId).map((each) => each.name),
      ["current"],
    );
    await older.close();
    assert.equal(core.org.connections.link(core.rootId), current);
  });
}

test("a closed candidate's delayed exposure completion cannot register it", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const online = core.org.online;
  const offline = core.org.offline;
  let complete: (() => void) | undefined;
  let candidate: ActorLink | undefined;
  let ended = false;
  core.org.online = (id, link, interfaces) => {
    candidate = link;
    complete = () => online(id, link, interfaces);
  };
  core.org.offline = (id, link) => {
    offline(id, link);
    if (link === candidate) ended = true;
  };
  const actor = await core.connect(core.root, fakeActor([iface("late")]));
  await until("exposure completion is held at the domain boundary", () => complete !== undefined);
  await actor.close();
  await until("the real socket's candidate has ended", () => ended);
  assert.ok(complete);
  complete();
  assert.equal(core.org.connections.link(core.rootId), undefined);
  assert.deepEqual(core.org.connections.interfaces(core.rootId), []);
});

test("Actor closure revokes every caller and advertising socket for that Actor", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor, credential } = await core.org.registry.create(
    core.rootId,
    "worker",
    "Receive work",
  );
  const worker = await core.connect(credential, fakeActor([]));
  const first = await core.client(credential);
  const second = await core.client(credential);
  const root = await core.client(core.root);
  assert.equal((await root.call("actor_close", { actor: actor.id })).state, "done");
  await until("all Actor sockets are revoked", () =>
    [worker, first, second].every((connection) => connection.ended === CLOSE_REVOKED),
  );
  for (const connection of [worker, first, second]) {
    await assert.rejects(connection.call("team"));
  }
  assert.equal(core.org.connections.link(actor.id), undefined);
  assert.equal((await root.call("team")).state, "done");
});

test("credential omission requires explicit policy and never accepts a supplied invalid credential", async (t) => {
  const core = await startCore({ allowCredentialOmission: (principal) => "actorId" in principal });
  t.after(() => core.close());
  const admitted = await connectClient({ url: core.url, actorId: core.rootId });
  t.after(() => admitted.close());
  assert.equal((await admitted.call("team")).state, "done");
  await assert.rejects(
    connectClient({ url: core.url, actorId: core.rootId, credential: "sentinel-invalid" }),
    /admission/,
  );
  await assert.rejects(connectClient({ url: core.url, actorId: "nonexistent" }), /admission/);
});

test("a second connect cannot rebind an admitted socket and its original Actor remains usable", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor, credential } = await core.org.registry.create(
    core.rootId,
    "other",
    "Another Actor",
  );
  const root = await peer(t, core, { actorId: core.rootId, credential: core.root });
  await initializeCaller(root);
  const reverse = await root.next("initialize");
  root.send({ id: reverse.id, error: { code: -32601, message: "Method not found" } });
  const refused = await root.request(
    "connection.connect",
    { actorId: actor.id, credential },
    "rebind",
  );
  assert.equal(refused.error?.code, -32600);
  assert.equal(refused.error?.data?.code, "identity_fixed");
  const team = await root.request("tools/call", { name: "team", arguments: { depth: 0 } }, "team");
  const value = team.result?.structuredContent as { positions: { id: string }[] };
  assert.equal(value.positions[0]?.id, core.rootId);
});

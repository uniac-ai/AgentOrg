/** Actor callers speak one MCP direction; advertisements cannot create callable Actor interfaces. */

import assert from "node:assert/strict";
import { once } from "node:events";
import { type TestContext, test } from "node:test";
import { WebSocket } from "ws";
import { connectClient } from "../src/actor/index.ts";
import { CONNECTION_PATH, type Identity } from "../src/connection/index.ts";
import { type Core, HUB_INTERFACES, startCore, until } from "./harness.ts";

interface Frame {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; data?: { code: string } };
}

/** A real caller that never implements or answers reverse MCP server requests. */
async function peer(t: TestContext, core: Core, identity: Identity) {
  const socket = new WebSocket(`${core.url.replace("http", "ws")}${CONNECTION_PATH}`);
  const frames: Frame[] = [];
  const reverseRequests: Frame[] = [];
  const closed = once(socket, "close");
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Frame;
    frames.push(frame);
    if (frame.method !== undefined && frame.id !== undefined) reverseRequests.push(frame);
  });
  await once(socket, "open");
  t.after(async () => {
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
    await closed;
  });
  const send = (frame: object) => socket.send(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  const request = async (method: string, params: object, id: string | number) => {
    send({ method, params, id });
    let found: Frame | undefined;
    await until(`the Hub replies to ${method}`, () => {
      const index = frames.findIndex((frame) => frame.method === undefined && frame.id === id);
      if (index < 0) return false;
      found = frames.splice(index, 1)[0];
      return true;
    });
    assert.ok(found);
    return found;
  };
  const admitted = await request("connection.connect", identity, "admission");
  assert.deepEqual(Object.keys(admitted.result ?? {}), ["connectionId"]);
  assert.equal(typeof admitted.result?.connectionId, "string");
  const initialize = async () => {
    const result = await request(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "ordinary-caller", version: "0" },
      },
      "initialize",
    );
    assert.equal(result.error, undefined);
    send({ method: "notifications/initialized" });
  };
  return { send, request, initialize, reverseRequests };
}

test("ordinary callers list and call explicit Hub Tools without a reverse server", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor: lead } = await core.org.registry.create(core.rootId, "lead", "Lead");
  const { actor: worker, credential } = await core.org.registry.create(lead.id, "worker", "Work");
  const root = await peer(t, core, { actorId: core.rootId, credential: core.root });
  const child = await peer(t, core, { actorId: worker.id, credential });
  for (const caller of [root, child]) {
    await caller.initialize();
    const listing = await caller.request("tools/list", {}, "list");
    const tools = listing.result?.tools as { name: string }[];
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      Object.values(HUB_INTERFACES).flat().sort(),
    );
    const team = await caller.request(
      "tools/call",
      { name: "team", arguments: { depth: 0 } },
      "team",
    );
    assert.ok(
      Array.isArray(
        team.result?.structuredContent &&
          (team.result.structuredContent as { positions: unknown[] }).positions,
      ),
    );
    assert.deepEqual(caller.reverseRequests, []);
  }
  assert.equal(core.org.connections.connected(worker.id), true);
});

test("root, hierarchy and unsolicited advertisements never expose or invoke Actor interfaces", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor: lead, credential: leadCredential } = await core.org.registry.create(
    core.rootId,
    "lead",
    "Lead",
  );
  const { actor: worker, credential } = await core.org.registry.create(lead.id, "worker", "Work");
  const advertiser = await peer(t, core, { actorId: worker.id, credential });
  await advertiser.initialize();
  const advertised = {
    tools: [
      {
        name: "review",
        inputSchema: { type: "object" },
        _meta: { "agentorg/tool": { id: "hub:actors", name: "actors", interface: "actor_create" } },
      },
    ],
  };
  advertiser.send({ id: 999, result: advertised });
  advertiser.send({ method: "notifications/tools/list_changed", params: advertised });
  await advertiser.request("ping", {}, "advertisement-barrier");
  const root = await core.client(core.root);
  const manager = await core.client(leadCredential);
  for (const caller of [root, manager]) {
    const catalog = await caller.available();
    assert.deepEqual(
      catalog.map((tool) => tool.id).sort(),
      Object.keys(HUB_INTERFACES)
        .map((name) => `hub:${name}`)
        .sort(),
    );
    for (const alias of [
      "review",
      "worker.review",
      "manager.review",
      "lead.worker.review",
      `${worker.id}.review`,
      "actor_expose",
    ]) {
      const answer = await caller.call(alias);
      assert.equal(answer.state, "refused");
      assert.equal(answer.state === "refused" && answer.code, "not_found");
    }
  }
  const forged = await advertiser.request(
    "tools/call",
    {
      name: "manager.review",
      arguments: {},
      _meta: { "agentorg/tool": { id: "hub:team", interface: "team" } },
    },
    "forged-call",
  );
  assert.equal(forged.result?.isError, true);
  assert.deepEqual(advertiser.reverseRequests, []);
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

test("a second admission request cannot rebind an Actor's connection", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor, credential } = await core.org.registry.create(core.rootId, "other", "Other");
  const root = await peer(t, core, { actorId: core.rootId, credential: core.root });
  await root.initialize();
  const refused = await root.request(
    "connection.connect",
    { actorId: actor.id, credential },
    "rebind",
  );
  assert.equal(refused.error?.data?.code, "identity_fixed");
  const team = await root.request("tools/call", { name: "team", arguments: { depth: 0 } }, "team");
  assert.ok(team.result);
  assert.equal(
    (team.result.structuredContent as { positions: { id: string }[] }).positions[0]?.id,
    core.rootId,
  );
  assert.deepEqual(root.reverseRequests, []);
});

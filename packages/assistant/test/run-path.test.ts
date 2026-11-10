// The run path against a real Hub: a stand-in Actor exports tools@1 at run time, and the person
// exposes it to a running agent, as `hub.grants.expose` does for an MCP connection.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Hub, type HubOptions, listen, PERSON } from "@agentorg/hub";
import { chat, hubActors, hubGrants, kv, llmSession, tools } from "@agentorg/interfaces";
import { connect } from "@agentorg/sdk/client";
import engine from "./engine-actor.ts";

type Item = { type: string; callId?: string; output?: string };
type Request = { input: Item[]; tools?: { name: string; parameters: unknown }[] };

async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const SEARCH = {
  name: "repo.search",
  description: "Search the repository.",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};
const BROKEN = { name: "broken", inputSchema: { type: "object" } };
const FRESH = { name: "fresh", inputSchema: { type: "object" } };

async function cast(t: test.TestContext, options: HubOptions = {}) {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-run-path-")), "home");
  const hub = Hub.open(home, options);
  const server = await listen(hub);
  const clients: { close(): void }[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
    hub.close();
    rmSync(dirname(home), { recursive: true, force: true });
  });
  const hubUrl = server.url;
  const person = await connect({
    hubUrl,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, grants: hubGrants },
    declare: false,
  });
  clients.push(person);
  const make = async (name: string) => {
    const made = await person.slots.actors.call.create({ name });
    return { actorId: made.actorId, credential: made.credential ?? "" };
  };

  // What the agent is bound to: a scripted model and a store in memory.
  const requests: Request[] = [];
  const script: Record<string, unknown>[][] = [];
  /** How long the next replies take, in order. */
  const delays: number[] = [];
  const values = new Map<string, unknown>();
  const backingId = await make("Backing");
  const backing = await connect({
    hubUrl,
    ...backingId,
    exports: { model: llmSession, store: kv },
  });
  clients.push(backing);
  backing.exports.model.implement({
    models: async () => ({ models: [] }),
    respond: async (request) => {
      requests.push(request as Request);
      await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0));
      return {
        output: (script.shift() ?? [
          { type: "message", role: "assistant", content: "ok" },
        ]) as never,
      };
    },
    cancel: async () => ({}),
  });
  backing.exports.store.implement({
    get: async ({ key }) => (values.has(key) ? { value: values.get(key) as never } : {}),
    set: async ({ key, value }) => {
      values.set(key, value);
      return {};
    },
    delete: async ({ key }) => ({ deleted: values.delete(key) }),
    list: async ({ prefix = "" }) => ({
      keys: [...values.keys()].filter((key) => key.startsWith(prefix)).sort(),
      next: null,
    }),
  });

  // The agent, running, before anything is exposed to it.
  const agentId = await make("Agent");
  const agent = await connect({
    hubUrl,
    ...agentId,
    slots: engine.slots,
    exports: engine.exports,
    start: engine.start,
  });
  clients.push(agent);
  for (const [slot, name] of [
    ["model", "model"],
    ["store", "store"],
  ] as const)
    await person.slots.grants.call.bind({
      consumer: agentId.actorId,
      slot,
      provider: backingId.actorId,
      export: name,
    });
  await until(() => agent.slots.store.bound && agent.slots.model.bound, "the agent's bindings");

  const callerId = await make("Caller");
  const caller = await connect({ hubUrl, ...callerId, slots: { chat } });
  clients.push(caller);
  await person.slots.grants.call.bind({
    consumer: callerId.actorId,
    slot: "chat",
    provider: agentId.actorId,
    export: "chat",
  });
  await until(() => caller.slots.chat.bound, "the caller's binding");

  /** One turn: the requests it made, from the first. */
  const turn = async (text: string, ms?: number) => {
    const from = requests.length;
    const { chats } = await caller.slots.chat.call.list({});
    await caller.slots.chat.call.send({
      ...(chats[0] ? { chat: chats[0].id } : {}),
      text,
    });
    await until(
      async () =>
        requests.length > from && (await caller.slots.chat.call.state({})).state === "idle",
      "the turn to end",
      ms,
    );
    return requests.slice(from);
  };
  const names = (request: Request | undefined) => request?.tools?.map((tool) => tool.name);

  // The stand-in connection: an Actor exporting tools@1, whose list can change.
  const standInId = await make("Stand-in");
  const listing = { tools: [SEARCH, BROKEN] };
  const called: unknown[] = [];
  const startStandIn = async () => {
    const standIn = await connect({ hubUrl, ...standInId, exports: { tools } });
    clients.push(standIn);
    standIn.exports.tools.implement({
      list: async () => listing,
      call: async (input) => {
        called.push(input);
        return input.name === "broken"
          ? { output: "it broke", failed: true as const }
          : { output: `found ${JSON.stringify(input.arguments)}` };
      },
    });
    return standIn;
  };
  const standIn = await startStandIn();

  const expose = async () => {
    const answer = await person.slots.grants.call.expose({
      provider: standInId.actorId,
      export: "tools",
      to: agentId.actorId,
      as: "lookup",
    });
    assert.deepEqual(answer, { exposed: true, slot: "lookup" });
    await until(() => agent.exposed().length === 1, "the exposure to arrive");
  };
  const unexpose = async () => {
    await person.slots.grants.call.unexpose({ to: agentId.actorId, slot: "lookup" });
    await until(() => agent.exposed().length === 0, "the exposure to go");
  };
  return { turn, names, script, delays, listing, called, standIn, startStandIn, expose, unexpose };
}

const callOf = (name: string, args: unknown, callId: string) => ({
  type: "function_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});
const outputOf = (request: Request | undefined, callId: string) =>
  request?.input.find((item) => item.type === "function_call_output" && item.callId === callId)
    ?.output;

test("a tools@1 export exposed to a running agent is offered, called, and changes with its list", async (t) => {
  const s = await cast(t);
  assert.deepEqual(s.names((await s.turn("before"))[0]), []);

  await s.expose();
  s.script.push([callOf("lookup__repo_search", { q: "hub" }, "c1")]);
  s.script.push([callOf("lookup__broken", {}, "c2")]);
  const [first, second, third] = await s.turn("use it");
  // At the next request, with no restart, under `<slot>__<tool>`, with the server's own schema.
  assert.deepEqual(s.names(first), ["lookup__repo_search", "lookup__broken"]);
  assert.deepEqual(first?.tools?.[0]?.parameters, SEARCH.inputSchema);
  // A call goes through the slot, under the server's own name for the tool.
  assert.deepEqual(s.called[0], { name: "repo.search", arguments: { q: "hub" } });
  assert.equal(outputOf(second, "c1"), 'found {"q":"hub"}');
  // A tool that ran and failed: its own words reach the model.
  assert.equal(outputOf(third, "c2"), "it broke");

  // The list is the server's now: changed, and the next request has the new one.
  s.listing.tools = [FRESH];
  s.standIn.exports.tools.emit("changed", {});
  assert.deepEqual(s.names((await s.turn("again"))[0]), ["lookup__fresh"]);

  await s.unexpose();
  assert.deepEqual(s.names((await s.turn("after"))[0]), []);
});

test("a connection that goes down has its tools left out until it is back", async (t) => {
  const s = await cast(t);
  await s.expose();
  assert.deepEqual(s.names((await s.turn("up"))[0]), ["lookup__repo_search", "lookup__broken"]);

  s.standIn.close();
  await s.standIn.closed;
  assert.deepEqual(s.names((await s.turn("down"))[0]), []);

  await s.startStandIn();
  let back: string[] | undefined;
  for (let i = 0; i < 20 && !back?.length; i++) back = s.names((await s.turn("back?"))[0]);
  assert.deepEqual(back, ["lookup__repo_search", "lookup__broken"]);
});

test("a long turn completes: 60 tool calls, with a reply slower than the Hub's usual limit", async (t) => {
  // As the app sets them, scaled so the reply outlasts the general limit; AGENTORG_TEST_REPLY_MS=90000
  // runs it at the real 60 seconds and ten minutes.
  const replyMs = Number(process.env.AGENTORG_TEST_REPLY_MS ?? 5000);
  const s = await cast(t, {
    answerTimeoutMs: Math.round((replyMs * 2) / 3),
    answerTimeoutsMs: { "llm.session@1": Math.round((replyMs * 20) / 3) },
  });
  await s.expose();
  for (let i = 0; i < 60; i++)
    s.script.push([callOf("lookup__repo_search", { q: `q${i}` }, `c${i}`)]);
  s.delays.push(replyMs);
  const requests = await s.turn("a long one", replyMs + 60_000);
  assert.equal(requests.length, 61);
  assert.equal(s.called.length, 60);
  assert.equal(outputOf(requests[60], "c59"), 'found {"q":"q59"}');
});

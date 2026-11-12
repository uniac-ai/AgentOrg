// The bundled agent provider against a real Hub, with a stand-in model. The provider holds only
// `hub.actors` and its own binding to the model, as a real one does.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hub, listen, PERSON } from "@agentorg/hub";
import {
  agentProvider,
  agentSettings,
  chat,
  hubActors,
  hubExports,
  hubGrants,
  llmSession,
  tools,
} from "@agentorg/interfaces";
import { NotConnected, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { createLocalStore } from "../src/local-store.ts";
import { startAgentProvider } from "../src/provider.ts";
import { asAsked } from "./as-asked.ts";

type Request = {
  requestId: string;
  model?: string;
  instructions: string;
  input: { type: string; content?: string }[];
  tools?: { name: string }[];
};

const refused = (code: string) => (error: unknown) =>
  error instanceof Refused && error.code === code;
async function until(condition: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const say = (content: string) => [{ type: "message", role: "assistant", content }];

async function setup(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-agents-")));
  const home = join(root, "home");
  const dir = join(root, "provider");
  const hub = Hub.open(home);
  const server = await listen(hub);
  const hubUrl = server.url;
  const leaving: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    for (const leave of leaving.reverse()) await leave();
    await server.close();
    hub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const person = await connect({
    hubUrl,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, grants: hubGrants, exports: hubExports },
    declare: false,
  });
  leaving.push(() => person.close());
  const join_ = async <T extends { close(): void }>(client: Promise<T>) => {
    const joined = await client;
    leaving.push(() => joined.close());
    return joined;
  };

  // The stand-in model: answers from a script, or waits for a gate.
  const requests: Request[] = [];
  const cancelled: string[] = [];
  const replies: unknown[][] = [];
  const gates: Promise<void>[] = [];
  const modelActor = hub.state.createActor(PERSON, { name: "Stand-in model" });
  const model = await join_(
    connect({
      hubUrl,
      actorId: modelActor.actorId,
      credential: modelActor.credential as string,
      exports: { session: llmSession },
    }),
  );
  model.exports.session.implement({
    models: async () => ({
      models: [
        { id: "gpt-a", name: "A" },
        { id: "gpt-b", name: "B" },
      ],
    }),
    respond: async (request) => {
      // The main loop is answered at once, with new work; `requests` are the workers'.
      if (request.tools?.some((tool) => tool.name === "route"))
        return {
          output: [
            { type: "function_call", callId: "r", name: "route", arguments: '{"title":"Work"}' },
          ],
        };
      requests.push(asAsked(request) as Request);
      await gates.shift();
      return { output: (replies.shift() ?? say("ok")) as never };
    },
    cancel: async ({ requestId }) => {
      cancelled.push(requestId);
      return {};
    },
  });

  // The provider: not a manager, holding only hub.actors and its binding to the model.
  const made = hub.state.createActor(PERSON, {
    name: "Agents",
    bindings: [
      { slot: "actors", provider: "hub", export: "actors" },
      { slot: "model", provider: modelActor.actorId, export: "session" },
    ],
  });
  assert.equal(hub.state.isManager(made.actorId), false);
  const start = () =>
    startAgentProvider({
      hubUrl,
      actorId: made.actorId,
      credential: made.credential as string,
      model: { actor: modelActor.actorId, export: "session" },
      dir,
    });
  const running = { current: await start() };
  leaving.push(() => running.current.close());

  const asks = hub.state.createActor(PERSON, {
    name: "Asks",
    bindings: [{ slot: "agents", provider: made.actorId, export: "provider" }],
  });
  const caller = await join_(
    connect({
      hubUrl,
      actorId: asks.actorId,
      credential: asks.credential as string,
      slots: { agents: agentProvider, chat },
    }),
  );
  await until(() => caller.slots.agents.bound, "the caller's binding");
  const agents = caller.slots.agents.call;

  /** Make an Assistant and connect the caller to its chat. */
  const create = async (name = "Scout") => {
    const answer = await agents.create({ creatable: "assistant", name, answers: {} });
    hub.state.bind(PERSON, {
      consumer: asks.actorId,
      slot: "chat",
      provider: answer.agent,
      export: answer.chat,
    });
    await until(() => caller.slots.chat.bound, "the chat binding");
    return answer;
  };
  const talk = caller.slots.chat.call;
  /** The one chat of the agent the caller is bound to, once a message has started it. */
  const one = async () => (await talk.list({})).chats[0]?.id;
  const turn = async (text: string) => {
    const from = requests.length;
    const before = await one();
    await talk.send({ ...(before ? { chat: before } : {}), text });
    await until(
      async () => requests.length > from && (await talk.state({})).state === "idle",
      "the turn to end",
    );
    return requests[from] as Request;
  };
  const texts = async () => {
    const chat = await one();
    if (!chat) return [];
    return (await talk.history({ chat })).messages.map((m) => `${m.role}: ${m.text}`);
  };
  const restart = async () => {
    await running.current.close();
    running.current = await start();
  };
  return {
    hub,
    hubUrl,
    dir,
    person,
    join_,
    agents,
    create,
    talk,
    one,
    turn,
    texts,
    restart,
    requests,
    replies,
    gates,
    cancelled,
    caller,
    made,
    modelActor,
  };
}

test("it offers Assistant, and refuses what it doesn't have", async (t) => {
  const s = await setup(t);
  const { creatables } = await s.agents.creatable({});
  assert.deepEqual(
    creatables.map((one) => [one.id, one.title, one.asks]),
    [["assistant", "Assistant", []]],
  );
  await assert.rejects(
    s.agents.create({ creatable: "other", name: "X", answers: {} }),
    refused("unknown"),
  );
  for (const call of [s.agents.status, s.agents.start, s.agents.stop, s.agents.remove])
    await assert.rejects(call({ agent: "act_nobody" }), refused("unknown"));
});

test("an Assistant is made running, bound to the model, with no store and nothing of its own to call", async (t) => {
  const s = await setup(t);
  const { agent, settings, chat: chatName } = await s.create();
  assert.deepEqual([settings, chatName], ["settings", "chat"]);
  assert.deepEqual(await s.agents.status({ agent }), { state: "running" });
  // A provider that isn't a manager gave the agent its own binding to the model.
  assert.deepEqual(
    s.hub.state
      .bindings(agent)
      .filter((b) => b.consumer === agent)
      .map((b) => [b.slot, b.provider, b.export]),
    [["model", s.modelActor.actorId, "session"]],
  );
  assert.deepEqual(
    (["model", "settings", "store", "actors"] as const).map(
      (slot) => s.hub.state.declaration(agent, "slot", slot) !== undefined,
    ),
    [true, true, false, false],
  );
  const request = await s.turn("hello");
  assert.deepEqual(request.tools, []);
  assert.match(request.instructions, /You act only through your tools/);
  assert.deepEqual(await s.texts(), ["user: hello", "assistant: ok"]);
});

test("stop and start keep the transcript, the model and the bindings", async (t) => {
  const s = await setup(t);
  const { agent } = await s.create();
  s.replies.push(say("first reply"));
  await s.turn("first");
  await s.agents.setModel({ agent, model: "gpt-b" });

  const chat = (await s.one()) as string;
  await s.agents.stop({ agent });
  assert.deepEqual(await s.agents.status({ agent }), { state: "stopped" });
  // It stays on its channel, so what was said can still be read, each chat where it was put.
  assert.equal(s.hub.connected(agent), true);
  assert.deepEqual(
    (await s.talk.list({})).chats.map((one) => [one.id, one.archived]),
    [[chat, false]],
  );
  assert.equal((await s.talk.history({ chat })).messages.length, 2);
  // It takes no message, in that chat or a new one.
  const stopped = { code: "busy", message: /It is stopped/ };
  await assert.rejects(s.talk.send({ chat, text: "second" }), stopped);
  await assert.rejects(s.talk.send({ text: "second" }), stopped);
  assert.equal(s.requests.length, 1);
  // Stopping again changes nothing.
  await s.agents.stop({ agent });

  await s.agents.start({ agent });
  assert.deepEqual(await s.agents.status({ agent }), { state: "running" });
  assert.deepEqual(await s.texts(), ["user: first", "assistant: first reply"]);
  assert.deepEqual(await s.agents.models({ agent }), {
    models: [
      { id: "gpt-a", name: "A" },
      { id: "gpt-b", name: "B" },
    ],
    current: "gpt-b",
  });
  await assert.rejects(s.agents.setModel({ agent, model: "gpt-z" }), { code: "unknown" });
  await assert.rejects(s.agents.models({ agent: "act_none" }), { code: "unknown" });
  const request = await s.turn("second");
  assert.equal(request.model, "gpt-b");
  assert.deepEqual(
    request.input.map((item) => item.content),
    ["first", "first reply", "second"],
  );
  // Starting one already running changes nothing.
  await s.agents.start({ agent });
  assert.deepEqual(await s.agents.status({ agent }), { state: "running" });
});

test("stopping cuts a turn in progress, and what was said stays", async (t) => {
  const s = await setup(t);
  const { agent } = await s.create();
  let release = () => {};
  s.gates.push(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await s.talk.send({ text: "a long one" });
  await until(() => s.requests.length === 1, "the request");
  await s.agents.stop({ agent });
  assert.equal(s.cancelled.length, 1);
  release();
  await s.agents.start({ agent });
  assert.deepEqual(await s.texts(), ["user: a long one"]);
  assert.deepEqual(await s.talk.state({}), { state: "idle" });
});

test("a provider restart brings running agents back, and leaves stopped ones stopped", async (t) => {
  const s = await setup(t);
  const { agent: up } = await s.agents.create({ creatable: "assistant", name: "Up", answers: {} });
  const { agent: down } = await s.create("Down");
  await s.turn("remember this");
  const chat = (await s.one()) as string;
  await s.agents.stop({ agent: down });

  await s.restart();
  await until(() => s.caller.slots.agents.bound, "the provider to be back");
  assert.deepEqual(await s.agents.status({ agent: up }), { state: "running" });
  assert.deepEqual(await s.agents.status({ agent: down }), { state: "stopped" });
  assert.equal(s.hub.connected(up), true);
  // The stopped one is back on its channel too, as it was left: read, and taking nothing.
  await until(() => s.caller.slots.chat.bound && s.hub.connected(down), "the stopped one");
  assert.deepEqual(
    (await s.talk.list({})).chats.map((one) => one.id),
    [chat],
  );
  assert.deepEqual(
    (await s.talk.history({ chat })).messages.map((m) => m.text),
    ["remember this", "ok"],
  );
  await assert.rejects(s.talk.send({ chat, text: "more" }), { code: "busy" });
  await s.agents.start({ agent: down });
  assert.deepEqual(await s.texts(), ["user: remember this", "assistant: ok"]);
});

test("a turn the provider's restart cut off goes on when it is back", async (t) => {
  const s = await setup(t);
  await s.create();
  let release = () => {};
  s.gates.push(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await s.talk.send({ text: "a long one" });
  await until(() => s.requests.length === 1, "the request");
  await s.restart();
  release();
  await until(() => s.requests.length === 2, "the turn to go on");
  assert.match(String(s.requests[1]?.input.at(-1)?.content), /cut off by a restart/);
  await until(async () => (await s.texts()).at(-1) === "assistant: ok", "its reply");
  assert.deepEqual(await s.texts(), [
    "user: a long one",
    "tool: Cut off by a restart: going on from where it stopped.",
    "assistant: ok",
  ]);
});

test("a stopped agent whose connection ended is down until it is stopped or started again", async (t) => {
  const s = await setup(t);
  const { agent } = await s.create();
  await s.turn("hello");
  const one = (await s.one()) as string;
  await s.agents.stop({ agent });
  // Another channel for the same Actor takes its place, then goes.
  const { credential } = JSON.parse(readFileSync(join(s.dir, "agents.json"), "utf8"))[agent];
  const other = await connect({
    hubUrl: s.hubUrl,
    actorId: agent,
    credential,
    slots: { model: llmSession, settings: agentSettings },
    exports: { chat },
    start() {},
  });
  other.close();
  await until(
    async () => (await s.agents.status({ agent })).state === "down",
    "the agent to be down",
  );
  // Off its channel, it can't say its models.
  await assert.rejects(s.agents.models({ agent }), { code: "unavailable" });
  // Stopped again, it joins as it was left: read, and taking nothing.
  await s.agents.stop({ agent });
  assert.deepEqual(await s.agents.status({ agent }), { state: "stopped" });
  await until(() => s.caller.slots.chat.bound && s.hub.connected(agent), "the agent to be back");
  assert.equal((await s.talk.history({ chat: one })).messages.length, 2);
  await assert.rejects(s.talk.send({ chat: one, text: "more" }), { code: "busy" });
  await s.agents.start({ agent });
  assert.deepEqual(await s.agents.status({ agent }), { state: "running" });
  await s.turn("again");
  assert.equal((await s.talk.history({ chat: one })).messages.length, 4);
});

test("settings and an exposed tools@1 reach the agent as they do any engine", async (t) => {
  const s = await setup(t);
  const { agent, settings } = await s.create();
  const made = s.hub.state.createActor(PERSON, { name: "Management" });
  const management = await s.join_(
    connect({
      hubUrl: s.hubUrl,
      actorId: made.actorId,
      credential: made.credential as string,
      exports: { settings: agentSettings, tools },
    }),
  );
  management.exports.settings.implement({
    get: async () => ({
      instructions: "You keep the docs.",
      skills: [{ name: "review", description: "Review a change." }],
    }),
    skill: async () => ({ text: "# Review" }),
  });
  management.exports.tools.implement({
    list: async () => ({ tools: [{ name: "search", inputSchema: { type: "object" } }] }),
    call: async () => ({ output: "" }),
  });
  s.hub.state.bind(PERSON, {
    consumer: agent,
    slot: settings,
    provider: made.actorId,
    export: "settings",
  });
  s.hub.state.expose(PERSON, { provider: made.actorId, export: "tools", to: agent, as: "lookup" });
  await until(async () => {
    const request = await s.turn("anything new?");
    return request.tools?.length === 2 && request.instructions.startsWith("You keep the docs.");
  }, "the settings and tools to arrive");
  assert.deepEqual(
    s.requests.at(-1)?.tools?.map((tool) => tool.name),
    ["settings__skill", "lookup__search"],
  );
});

test("remove closes the Actor and deletes its record, and an agent closed elsewhere is down", async (t) => {
  const s = await setup(t);
  const { agent } = await s.create();
  await s.turn("hello");
  const folder = join(s.dir, "agents", agent);
  assert.ok(existsSync(folder));
  await s.agents.remove({ agent });
  assert.equal(s.hub.state.actor(agent).state, "closed");
  assert.equal(existsSync(folder), false);
  await assert.rejects(s.agents.status({ agent }), refused("unknown"));

  const { agent: other } = await s.agents.create({
    creatable: "assistant",
    name: "Other",
    answers: {},
  });
  await s.person.slots.actors.call.close({ actorId: other });
  await until(
    async () => (await s.agents.status({ agent: other })).state === "down",
    "the agent to be down",
  );
  await assert.rejects(s.agents.start({ agent: other }));
  // A later provider forgets it: the Hub no longer knows it.
  await s.restart();
  await until(() => s.caller.slots.agents.bound, "the provider to be back");
  await until(
    () =>
      s.agents.status({ agent: other }).then(
        () => false,
        (error: unknown) => refused("unknown")(error),
      ),
    "the agent to be forgotten",
  );
});

test("the local store answers as kv@1: JSON values, ordered keys, pages", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentorg-kv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalStore(dir);
  assert.deepEqual(await store.get({ key: "none" }), {});
  assert.deepEqual(await store.list({}), { keys: [], next: null });
  assert.deepEqual(await store.delete({ key: "none" }), { deleted: false });
  await store.set({ key: "msg/2", value: { a: 1 } });
  await store.set({ key: "msg/1", value: null });
  await store.set({ key: "other", value: "x" });
  assert.deepEqual(await store.get({ key: "msg/2" }), { value: { a: 1 } });
  assert.deepEqual(await store.get({ key: "msg/1" }), { value: null });
  assert.deepEqual(await store.list({ prefix: "msg/", limit: 1 }), {
    keys: ["msg/1"],
    next: "msg/1",
  });
  assert.deepEqual(await store.list({ prefix: "msg/", limit: 1, after: "msg/1" }), {
    keys: ["msg/2"],
    next: null,
  });
  assert.deepEqual(await store.delete({ key: "other" }), { deleted: true });
  assert.deepEqual(await store.get({ key: "other" }), {});
});

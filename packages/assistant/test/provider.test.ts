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
  type CapabilityDefinition,
  capabilityProvider,
  chat,
  hubActors,
  hubExports,
  hubGrants,
  llmSession,
  tools,
} from "@agentorg/interfaces";
import { NotConnected, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import type { Context } from "cordis";
import type { z } from "zod";
import { createLocalStore } from "../src/local-store.ts";
import type { AgentPlugin } from "../src/plugins.ts";
import { startAgentProvider, withoutOf } from "../src/provider.ts";
import { asAsked, followsSend, named, sendOf } from "./as-asked.ts";
import { saying } from "./saying.ts";

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
/** The worker's reply, sent to the newest message. */
const say = (content: string) => [sendOf(content)];

/** `plugins` are those the provider carries. */
async function setup(
  t: test.TestContext,
  plugins: AgentPlugin[] = [],
  offers: z.infer<typeof CapabilityDefinition>[] = [],
) {
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
      // A message heard apart while a call runs asks for no stop; `requests` are the agent's own.
      if (request.tools?.some((tool) => tool.name === "route")) return { output: [] };
      // One that only follows what was sent is answered with nothing, and is not among `requests`.
      if (followsSend(request.input as never)) return { output: [] };
      requests.push(asAsked(request) as Request);
      await gates.shift();
      return {
        output: named((replies.shift() ?? say("ok")) as never, request.input as never) as never,
      };
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
      plugins,
      offers,
    });
  const running = { current: await start() };
  leaving.push(() => running.current.close());

  const asks = hub.state.createActor(PERSON, {
    name: "Asks",
    bindings: [
      { slot: "agents", provider: made.actorId, export: "provider" },
      { slot: "capabilities", provider: made.actorId, export: "capabilities" },
    ],
  });
  const caller = await join_(
    connect({
      hubUrl,
      actorId: asks.actorId,
      credential: asks.credential as string,
      slots: { agents: agentProvider, capabilities: capabilityProvider, chat },
    }),
  );
  await until(
    () => caller.slots.agents.bound && caller.slots.capabilities.bound,
    "the caller's bindings",
  );
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
  /** Who the caller's one conversation with the agent is with, once a message has begun it. */
  const one = async () => (await talk.list({})).conversations[0]?.with;
  const turn = async (text: string) => {
    const from = requests.length;
    await talk.send({ text });
    await until(
      async () => requests.length > from && (await talk.state({})).state === "idle",
      "the turn to end",
    );
    return requests[from] as Request;
  };
  const texts = async () => (await talk.history({})).messages.map((m) => `${m.role}: ${m.text}`);
  /** How an agent stands, as most of these tests compare it: its state and why, not what it holds. */
  const standing = async (input: { agent: string }) => {
    const { mounted: _, ...rest } = await agents.status(input);
    return rest;
  };
  const restart = async () => {
    await running.current.close();
    running.current = await start();
  };
  return {
    standing,
    capabilities: caller.slots.capabilities.call,
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
    callerId: asks.actorId,
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
  assert.deepEqual(await s.standing({ agent }), { state: "running" });
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
  assert.equal(request.instructions, "You are an assistant in AgentOrg.");
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
  assert.deepEqual(await s.standing({ agent }), { state: "stopped" });
  // It stays on its channel, so what was said can still be read.
  assert.equal(s.hub.connected(agent), true);
  assert.deepEqual(
    (await s.talk.list({})).conversations.map((one) => one.with),
    [chat],
  );
  assert.equal((await s.talk.history({})).messages.length, 2);
  // It takes no message.
  const stopped = { code: "busy", message: /It is stopped/ };
  await assert.rejects(s.talk.send({ text: "second" }), stopped);
  assert.equal(s.requests.length, 1);
  // Stopping again changes nothing.
  await s.agents.stop({ agent });

  await s.agents.start({ agent });
  assert.deepEqual(await s.standing({ agent }), { state: "running" });
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
  // The caller here is an Actor, not the person: the model is told who it is.
  const from = `(from ${s.callerId}) `;
  assert.deepEqual(
    request.input.map((item) => item.content),
    [`${from}first`, "first reply", `${from}second`],
  );
  // Starting one already running changes nothing.
  await s.agents.start({ agent });
  assert.deepEqual(await s.standing({ agent }), { state: "running" });
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
  assert.deepEqual(await s.standing({ agent: up }), { state: "running" });
  assert.deepEqual(await s.standing({ agent: down }), { state: "stopped" });
  assert.equal(s.hub.connected(up), true);
  // The stopped one is back on its channel too, as it was left: read, and taking nothing.
  await until(() => s.caller.slots.chat.bound && s.hub.connected(down), "the stopped one");
  assert.deepEqual(
    (await s.talk.list({})).conversations.map((one) => one.with),
    [chat],
  );
  assert.deepEqual(
    (await s.talk.history({})).messages.map((m) => m.text),
    ["remember this", "ok"],
  );
  await assert.rejects(s.talk.send({ text: "more" }), { code: "busy" });
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
  // Its chat has the reply; the line that says it went on is its work's.
  assert.deepEqual(await s.texts(), ["user: a long one", "assistant: ok"]);
});

test("a stopped agent whose connection ended is down until it is stopped or started again", async (t) => {
  const s = await setup(t);
  const { agent } = await s.create();
  await s.turn("hello");
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
  // Its connector says it can't do its part, and why.
  const connector = (await s.agents.status({ agent })).mounted?.find(
    ({ name }) => name === "connector",
  );
  assert.deepEqual(connector && { state: connector.state, detail: connector.detail }, {
    state: "down",
    detail: "Its connection to the Hub ended.",
  });
  // Off its channel, it can't say its models.
  await assert.rejects(s.agents.models({ agent }), { code: "unavailable" });
  // Stopped again, it joins as it was left: read, and taking nothing.
  await s.agents.stop({ agent });
  assert.deepEqual(await s.standing({ agent }), { state: "stopped" });
  await until(() => s.caller.slots.chat.bound && s.hub.connected(agent), "the agent to be back");
  assert.equal((await s.talk.history({})).messages.length, 2);
  await assert.rejects(s.talk.send({ text: "more" }), { code: "busy" });
  await s.agents.start({ agent });
  assert.deepEqual(await s.standing({ agent }), { state: "running" });
  await s.turn("again");
  assert.equal((await s.talk.history({})).messages.length, 4);
});

/** What the Assistant template gave an agent before the looper's frame said it for every agent. */
const EARLIER = `You are an assistant in AgentOrg, working for the person who created you.
You act only through your tools, and your tools are exactly the connections the person gave you. If something needs a connection you don't have, say which.
Before you promise to do something, check that one of your tools does it. A connection you are given later shows up as new tools at your next turn; until then, don't say you can use it.
Keep replies short and plain.`;

test("settings and an exposed tools@1 reach the agent as they do any engine", async (t) => {
  const s = await setup(t);
  const { agent, settings } = await s.create();
  let instructions = "You keep the docs.";
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
      instructions,
      skills: [{ name: "review", description: "Review a change." }],
    }),
    skill: async () => ({ text: "# Review" }),
  });
  management.exports.tools.implement({
    list: async () => ({ tools: [{ name: "search", inputSchema: { type: "object" } }] }),
    call: async () => ({ output: "" }),
    stop: async () => ({}),
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
  // An agent made when the template said more keeps those words, and is told the template's now.
  instructions = `${EARLIER}\n\nWhat you are for: docs.`;
  const request = await s.turn("and now?");
  assert.ok(
    request.instructions.startsWith("You are an assistant in AgentOrg.\n\nWhat you are for: docs."),
  );
});

/**
 * A stand-in for management's settings, bound to `agent` at `slot`: it names the plugins `names`
 * gives when asked, each with the settings `settings` has for it, and `changed` tells the agent
 * they changed.
 */
async function settingsOf(
  s: Awaited<ReturnType<typeof setup>>,
  agent: string,
  slot: string,
  names: () => string[],
  settings: Record<string, Record<string, string>> = {},
) {
  const made = s.hub.state.createActor(PERSON, { name: "Management" });
  const management = await s.join_(
    connect({
      hubUrl: s.hubUrl,
      actorId: made.actorId,
      credential: made.credential as string,
      exports: { settings: agentSettings },
    }),
  );
  management.exports.settings.implement({
    get: async () => ({
      instructions: "You keep the docs.",
      skills: [],
      plugins: names().map((name) => ({
        name,
        capability: name,
        ...(settings[name] ? { settings: settings[name] } : {}),
      })),
    }),
    skill: async () => {
      throw new Refused("unknown", "No skill is exposed.");
    },
  });
  s.hub.state.bind(PERSON, { consumer: agent, slot, provider: made.actorId, export: "settings" });
  return { changed: () => management.exports.settings.emit("changed", {}, { to: agent }) };
}
const offered = (request: Request) => request.tools?.map((tool) => tool.name) ?? [];

test("an agent holds the plugins its settings name, of those its provider carries: from when its settings are bound, at each turn, and when told they changed, with no restart", async (t) => {
  const said: string[] = [];
  const s = await setup(t, [saying("notes", said), saying("search", said)]);
  const { agent, settings } = await s.create();
  let names = ["notes"];
  const management = await settingsOf(s, agent, settings, () => names, { notes: { as: "mine" } });
  // Bound, with no message sent: what its settings name is loaded, with its settings.
  await until(() => said.includes("notes loaded as mine"), "the plugin its settings name");
  // Not told of a change, it still reads its settings for each turn: a turn is never behind
  // them, and what stays named stays loaded.
  names = ["notes", "search"];
  assert.deepEqual(offered(await s.turn("hello")), ["notes__do", "search__do"]);
  assert.deepEqual(said, ["notes loaded as mine", "search loaded"]);
  // Told they changed, with no message sent, it unloads what is no longer named, and stays up.
  names = ["search"];
  await until(() => {
    management.changed();
    return said.includes("notes unloaded");
  }, "the change to be heard");
  assert.deepEqual(said, ["notes loaded as mine", "search loaded", "notes unloaded"]);
  assert.deepEqual(await s.standing({ agent }), { state: "running" });
  assert.deepEqual(offered(await s.turn("and now?")), ["search__do"]);
});

test("a plugin its settings name that it can't hold, not carried or not loading, it runs without: it holds the others, says which and why while running, and holds it at a later turn once it can", async (t) => {
  const said: string[] = [];
  let room = false;
  const roomy: AgentPlugin = {
    name: "roomy",
    inject: ["tools"],
    apply(ctx: Context) {
      if (!room) throw new Error("No room");
      saying("roomy", said).apply(ctx, undefined);
    },
  };
  const s = await setup(t, [saying("notes", said), roomy]);
  const { agent, settings } = await s.create();
  let names = ["notes"];
  const management = await settingsOf(s, agent, settings, () => names);
  const running = (detail?: string) =>
    until(
      async () =>
        JSON.stringify(await s.standing({ agent })) ===
        JSON.stringify({ state: "running", ...(detail ? { detail } : {}) }),
      `the agent to be running${detail ? `: ${detail}` : ""}`,
    );
  await until(() => said.includes("notes loaded"), "the plugin its settings name");
  // Told its settings changed, and they name one its provider doesn't carry and one that doesn't
  // load: it runs on without both, keeps what it holds, and says each, with why.
  names = ["notes", "memory", "roomy"];
  management.changed();
  const both =
    "It runs without memory: this provider doesn't carry it.\nIt runs without roomy: no room.";
  await running(both);
  assert.deepEqual(offered(await s.turn("hello")), ["notes__do"]);
  assert.deepEqual(said, ["notes loaded"]);
  // Once one can be held, the next turn holds it, and the status says only the other.
  room = true;
  assert.deepEqual(offered(await s.turn("and now?")), ["notes__do", "roomy__do"]);
  await running("It runs without memory: this provider doesn't carry it.");
  // No longer named, the status says nothing more.
  names = ["notes", "roomy"];
  await s.turn("again?");
  await running();
  assert.deepEqual(said, ["notes loaded", "roomy loaded"]);
  // Back after a restart, with settings that name one it can't hold now, it says so before any
  // turn: what it holds as it joins the Hub is said.
  room = false;
  await s.restart();
  await running("It runs without roomy: no room.");
});

test("what a running agent's status says of the plugins it runs without: a sentence each, a line each, in the order named, within 2,000 characters", () => {
  assert.equal(withoutOf([]), undefined);
  assert.equal(
    withoutOf([
      { name: "memory", why: "didn't load", said: "Its lines couldn't be read." },
      { name: "search", why: "not carried" },
      { name: "counting", why: "needs a service" },
      { name: "keys", why: "didn't load", said: "API key missing" },
    ]),
    [
      "It runs without memory: its lines couldn't be read.",
      "It runs without search: this provider doesn't carry it.",
      "It runs without counting: it needs a service none of its plugins provides.",
      "It runs without keys: API key missing.",
    ].join("\n"),
  );
  // Whole lines while they fit; a first line too long for it alone is cut to fit.
  const long = { name: "long", why: "didn't load" as const, said: "x".repeat(1990) };
  const short = { name: "search", why: "not carried" as const };
  assert.equal(withoutOf([short, long]), "It runs without search: this provider doesn't carry it.");
  assert.equal(withoutOf([long, short])?.length, 2000);
});

test("an agent that joins the Hub again unloads the plugins it held before, and holds what its settings name afresh", async (t) => {
  const said: string[] = [];
  const s = await setup(t, [saying("notes", said)]);
  const { agent, settings } = await s.create();
  await settingsOf(s, agent, settings, () => ["notes"]);
  await until(() => said.includes("notes loaded"), "the plugin its settings name");
  // Another channel for the same Actor takes its place, then goes: its connection has ended.
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
  // What it held is still loaded, with no channel to work on, until it joins again.
  assert.deepEqual(said, ["notes loaded"]);
  await s.agents.start({ agent });
  await until(() => said.length === 3, "its plugins to be held afresh");
  assert.deepEqual(said, ["notes loaded", "notes unloaded", "notes loaded"]);
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

test("it offers the capabilities it carries, mounts one its agent's settings name, and says in the agent's status what it holds", async (t) => {
  const said: string[] = [];
  let room = true;
  const roomy: AgentPlugin = {
    name: "roomy",
    inject: ["tools"],
    apply() {
      if (!room) throw new Error("No room.");
    },
  };
  const offer = (id: string) => ({
    id,
    title: id === "notes" ? "Notes" : "Roomy",
    description: `The ${id} capability.`,
    arguments: { type: "object" as const, properties: {} },
  });
  const s = await setup(t, [saying("notes", said), roomy], [offer("notes"), offer("roomy")]);
  // Offered, by the names of the plugins it carries; one it doesn't carry can't be offered.
  assert.deepEqual(
    (await s.capabilities.capabilities({})).capabilities.map(({ id }) => id),
    ["notes", "roomy"],
  );
  const { agent, settings } = await s.create();
  let names: string[] = [];
  const management = await settingsOf(s, agent, settings, () => names);
  const mount = (capability: string) => s.capabilities.mount({ agent, capability, arguments: {} });
  // Not named by its settings: management keeps what is mounted, and names it there first.
  await assert.rejects(mount("notes"), refused("state"));
  names = ["notes"];
  assert.deepEqual(await mount("notes"), { mounted: "notes" });
  assert.ok(said.includes("notes loaded"));
  const held = async () =>
    ((await s.agents.status({ agent })).mounted ?? []).map(({ name, state, parent }) => ({
      name,
      state,
      ...(parent ? { parent } : {}),
    }));
  const bundled = ["agent", "store", "tools", "prompt", "connector", "model"].map((name) => ({
    name,
    state: "mounted",
  }));
  assert.deepEqual(await held(), [...bundled, { name: "notes", state: "mounted" }]);
  // One that can't be mounted is said with why, and nothing is mounted.
  room = false;
  names = ["notes", "roomy"];
  assert.deepEqual(await mount("roomy"), { problems: [{ message: "No room." }] });
  assert.deepEqual((await s.agents.status({ agent })).mounted?.at(-1), {
    name: "roomy",
    title: "roomy",
    state: "failed",
    detail: "No room.",
  });
  // Unmounted once its settings no longer name it; refused while they still do.
  await assert.rejects(s.capabilities.unmount({ agent, mounted: "notes" }), refused("state"));
  names = [];
  management.changed();
  assert.deepEqual(await s.capabilities.unmount({ agent, mounted: "notes" }), {});
  assert.ok(said.includes("notes unloaded"));
  assert.deepEqual(await held(), bundled);
  // What it doesn't offer, and an agent it didn't make, are unknown to it.
  await assert.rejects(mount("search"), refused("unknown"));
  await assert.rejects(
    s.capabilities.mount({ agent: "act_none", capability: "notes", arguments: {} }),
    refused("unknown"),
  );
});

test("a capability asks the agent's model with its own words, under the agent's model choice, and its question ends when it goes or the agent stops", async (t) => {
  type Ask = (asked: { instructions: string; input: object[] }) => Promise<unknown>;
  const asking: Ask[] = [];
  const asker: AgentPlugin = {
    name: "asker",
    inject: ["model", "capabilities"],
    apply(ctx: Context) {
      const { signal } = ctx.capabilities;
      asking.push((asked) => ctx.model.respond(asked as never, { signal }));
    },
  };
  const s = await setup(t, [asker]);
  const { agent, settings } = await s.create();
  let names = ["asker"];
  const management = await settingsOf(s, agent, settings, () => names);
  await until(() => asking.length > 0, "the asker to be held");
  await s.agents.setModel({ agent, model: "gpt-b" });
  const question = {
    instructions: "Sum it up.",
    input: [{ type: "message", role: "user", content: "One, two." }],
  };
  // Its own words only: no frame, no section, no function; the model chosen for the agent.
  const from = s.requests.length;
  await asking.at(-1)?.(question);
  const asked = s.requests[from] as Request & { requestId: string; model?: string };
  assert.equal(asked.instructions, "Sum it up.");
  assert.equal(asked.tools, undefined);
  assert.equal(asked.model, "gpt-b");
  assert.match(asked.requestId, /^capability-/);
  // The agent stopped: its question out now is cancelled.
  s.gates.push(new Promise(() => {}));
  // Never answered: what it rejects with as the test ends is nothing to it.
  void asking
    .at(-1)?.(question)
    .catch(() => {});
  await until(() => s.requests.length > from + 1, "the second question");
  const second = (s.requests.at(-1) as { requestId: string }).requestId;
  await s.agents.stop({ agent });
  await until(() => s.cancelled.includes(second), "the question to be cancelled");
  // Started again, the same asker is held: a stop unmounts nothing. Taken off, its question out
  // now is cancelled with it.
  await s.agents.start({ agent });
  assert.equal(asking.length, 1);
  s.gates.push(new Promise(() => {}));
  // Never answered: what it rejects with as the test ends is nothing to it.
  void asking
    .at(-1)?.(question)
    .catch(() => {});
  await until(() => s.requests.length > from + 2, "the third question");
  const third = (s.requests.at(-1) as { requestId: string }).requestId;
  names = [];
  management.changed();
  await until(() => s.cancelled.includes(third), "the question to be cancelled with its asker");
});

test("a capability's pass is told whose conversation a request is for, and what it adds is sent, its input at each request, never kept", async (t) => {
  // The note goes first: the stand-in model ends a turn by what its input ends with.
  const whose: AgentPlugin = {
    name: "whose",
    inject: ["context"],
    apply(ctx: Context) {
      ctx.context.pass((request) => {
        if (!request.loop) return;
        request.instructions.push({
          owner: "plugin:whose/with",
          text: `This conversation is with ${request.loop.with}.`,
        });
        request.input.unshift({ type: "message", role: "assistant", content: "(a note)" });
      });
    },
  };
  const s = await setup(t, [whose]);
  const { agent, settings } = await s.create();
  await settingsOf(s, agent, settings, () => ["whose"]);
  await until(
    async () =>
      ((await s.agents.status({ agent })).mounted ?? []).some(({ name }) => name === "whose"),
    "the capability to be held",
  );
  const first = await s.turn("hello");
  assert.match(
    String(first.instructions),
    new RegExp(`This conversation is with ${s.callerId}\\.`),
  );
  const notes = (request: Request) =>
    (request.input as { content?: unknown }[]).filter(({ content }) => content === "(a note)");
  assert.equal(notes(first).length, 1);
  assert.equal((first.input[0] as { content?: unknown }).content, "(a note)");
  // The next turn reads the record, which never kept the note: it is sent once, first.
  const second = await s.turn("and again");
  assert.equal(notes(second).length, 1);
  assert.equal((second.input[0] as { content?: unknown }).content, "(a note)");
});

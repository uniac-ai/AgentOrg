import assert from "node:assert/strict";
import test from "node:test";
import { chat, tools } from "@agentorg/interfaces";
import { capped, Entry, INPUT_BUDGET, MAX_OUTPUT, textOf } from "@agentorg/looper";
import { defineInterface, method, NotConnected, OutcomeUnknown, Refused } from "@agentorg/sdk";
import { createTestContext } from "@agentorg/sdk/testing";
import { z } from "zod";
import { MAX_INSTRUCTIONS } from "../src/settings.ts";
import { MAX_TOOLS, TOOLS_BUDGET } from "../src/tools.ts";
import { asAsked, followsSend, named, sendOf } from "./as-asked.ts";
import engine, { engines, INSTRUCTIONS } from "./engine-actor.ts";

/** An interface that isn't `tools@1`. */
const other = defineInterface({
  name: "other",
  major: 1,
  kind: "rpc",
  methods: { read: method({ input: z.object({}), output: z.object({}) }) },
});

/** Tools for an exposed `tools@1` slot, each a handler by name. */
type Handlers = Record<string, (input: Record<string, unknown>) => unknown>;
const listing = (handlers: Handlers) => ({
  list: () => ({
    tools: Object.keys(handlers).map((name) => ({ name, inputSchema: { type: "object" } })),
  }),
  call: async ({ name, arguments: input }: { name: string; arguments: unknown }) => ({
    output: JSON.stringify((await handlers[name]?.(input as Record<string, unknown>)) ?? {}),
  }),
});

type Item = { type: string; [key: string]: unknown };
type Request = {
  requestId: string;
  model?: string;
  instructions: string;
  input: Item[];
  tools?: { name: string; parameters: unknown }[];
};
type Reply = { output: Record<string, unknown>[] };
type Step = Reply | ((request: Request) => Reply | Promise<Reply>);
/** The worker's reply: sent to the newest message it read and hasn't handed back. */
const say = (content: string): Reply => ({ output: [sendOf(content)] });
/** What the worker writes without sending. */
const write = (content: string): Reply => ({
  output: [{ type: "message", role: "assistant", content }],
});
const callTool = (name: string, args: unknown, callId: string = crypto.randomUUID()) => ({
  type: "function_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});
const calls = (...items: ReturnType<typeof callTool>[]): Reply => ({ output: items });
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
/**
 * Everything the test's chat's record keeps, in order, each as its text: what was said in it, a
 * reply by what it sent, and what its work keeps there, said in no chat.
 */
const recorded = (s: { store: { values: Map<string, unknown> }; id(): string }) =>
  [...s.store.values.keys()]
    .filter((key) => key.startsWith(`chat/${encodeURIComponent(s.id())}/msg/`))
    .sort()
    .map((key) => textOf(Entry.parse(s.store.values.get(key))));

/** Wait for a condition, failing rather than hanging when it never comes. */
async function until(condition: () => boolean, what = "the condition") {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** A promise and the function that resolves it. */
function gate<T = void>() {
  let open: (value: T) => void = () => {};
  const shut = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { shut, open };
}

/** An in-memory kv@1 store's handlers. */
/** Values over storage's limit are refused as storage refuses them. */
const VALUE_LIMIT = 256 * 1024;
function memory(values = new Map<string, unknown>()) {
  const writes = { count: 0 };
  return {
    values,
    writes,
    handlers: {
      get: ({ key }: { key: string }) =>
        values.has(key) ? { value: values.get(key) as never } : {},
      set: ({ key, value }: { key: string; value: unknown }) => {
        if (bytes(JSON.stringify(value)) > VALUE_LIMIT) throw new Refused("quota", "too large");
        writes.count++;
        values.set(key, value);
        return {};
      },
      delete: ({ key }: { key: string }) => ({ deleted: values.delete(key) }),
      list: ({
        prefix = "",
        after,
        limit = 1000,
      }: {
        prefix?: string;
        after?: string;
        limit?: number;
      }) => {
        const keys = [...values.keys()]
          .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
          .sort()
          .slice(0, limit);
        return { keys, next: keys.length === limit ? (keys.at(-1) ?? null) : null };
      },
    },
  };
}

/** The person, as the Hub names them: the caller of the person's conversation. */
const PERSON = "person";
/** The assistant with an in-memory store and a scripted model. */
const OFFERED = [
  { id: "gpt-a", name: "A" },
  { id: "gpt-b", name: "B" },
];

type Actor = ReturnType<typeof createTestContext<typeof engine.slots, typeof engine.exports>>;
/** `rest` binds the rest of what the agent holds in the same go as its model, as at a start. */
/** The main loop's answer in these tests: every message nothing follows starts new work. */
const NEW_WORK = {
  type: "function_call",
  callId: "route",
  name: "route",
  arguments: '{"title":"Work"}',
};

async function setup(values = new Map<string, unknown>(), rest?: (actor: Actor) => void) {
  const actor = createTestContext(engine, { actorId: "assistant", module: "logic" });
  await actor.start();
  const host = engines.at(-1) as (typeof engines)[number];
  const store = memory(values);
  actor.bind("store", store.handlers);
  const requests: Request[] = [];
  /** The workers' requests as the model got them, with the looper's part. */
  const whole: Request[] = [];
  /** What the main loop was asked, and the arguments it answers `route` with when a test says. */
  const routed: Request[] = [];
  const routing: { to?: string; says?: string } = {};
  const cancels: string[] = [];
  const script: Step[] = [];
  const model = actor.bind("model", {
    models: () => ({ models: OFFERED }),
    respond: async (request) => {
      // The main loop is answered at once, with new work; `requests` and `script` are the workers'.
      if (request.tools?.some((tool) => tool.name === "route")) {
        routed.push(request as Request);
        const call = routing.to ? { ...NEW_WORK, arguments: routing.to } : undefined;
        if (routing.says !== undefined)
          return {
            output: [
              { type: "message", role: "assistant", content: routing.says },
              ...(call ? [call] : []),
            ],
          } as never;
        return { output: [call ?? NEW_WORK] } as never;
      }
      // A request that only follows what was sent is answered with nothing, as by a model that
      // has said all it had: it is not among `requests`, and takes nothing from `script`.
      if (followsSend((request as Request).input)) return { output: [] };
      requests.push(asAsked(request) as Request);
      whole.push(request as Request);
      const next = script.shift() ?? say("ok");
      const reply = typeof next === "function" ? await next(asAsked(request) as Request) : next;
      return { output: named(reply.output as never, (request as Request).input) } as never;
    },
    cancel: ({ requestId }) => {
      cancels.push(requestId);
      return {};
    },
  });
  rest?.(actor as Actor);
  const statuses = (from = 0) =>
    actor.emitted
      .slice(from)
      .filter((e) => e.event === "status")
      .map((e) => e.payload as { state: string });
  /**
   * Wait for the agent to go idle after `from`, and give the problem the person's conversation was
   * left with, if it was: what its `chat` event last said since.
   */
  const ended = async (from: number) => {
    await until(() => statuses(from).some((s) => s.state === "idle"), "the agent to go idle");
    type Told = { with: string; problem?: { code: string; message: string } };
    return actor.emitted
      .slice(from)
      .filter((e) => e.event === "chat")
      .map((e) => e.payload as Told)
      .findLast((told) => told.with === PERSON)?.problem;
  };
  /** Stop the agent, as its Stop does, and start it again once that has answered. */
  const cut = async () => {
    await host.stop();
    host.start();
  };
  /** A call on the person's conversation with the agent: the person calls. */
  const chat = (method: string, input: Record<string, unknown> = {}) =>
    actor.call("chat", method, input, PERSON);
  const turn = async (text: string) => {
    const from = actor.emitted.length;
    await chat("send", { text });
    return ended(from);
  };
  /** The thread of the conversation with `party`, the person's if none is named. */
  const id = (party = PERSON) =>
    (store.values.get(`conversations/${party}`) as { thread: string } | undefined)?.thread ?? "";
  /** The messages as a view shows them: one row per id, the latest event for it. */
  const messages = () => {
    const rows = new Map<string, string>();
    for (const e of actor.emitted.filter((e) => e.event === "message")) {
      const { id, role, text } = e.payload as { id: string; role: string; text: string };
      rows.set(id, `${role}: ${text}`);
    }
    return [...rows.values()];
  };
  return {
    actor,
    host,
    store,
    requests,
    whole,
    routed,
    routing,
    cancels,
    script,
    model,
    chat,
    id,
    turn,
    ended,
    cut,
    statuses,
    messages,
  };
}

test("what the agent's tools do is not in its chat, and the model reads how each call ended, after a restart too", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  s.actor.expose(
    "layout",
    tools,
    listing({
      place: () => ({ id: "p1" }),
      remove: () => {
        throw new Refused("unknown", "No such placement.");
      },
    }),
  );
  s.script.push(
    calls(
      callTool("layout__place", { actor: "board", module: "panel" }, "c1"),
      callTool("layout__remove", { id: "p9" }, "c2"),
    ),
  );
  await s.turn("Place it, then remove p9.");
  assert.deepEqual(s.messages(), ["user: Place it, then remove p9.", "assistant: ok"]);
  const { messages } = (await s.chat("history", {})) as { messages: { role: string }[] };
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.deepEqual(recorded(s), [
    "Place it, then remove p9.",
    "layout__place: done",
    "layout__remove: unknown",
    "ok",
  ]);
  const ends = (request: Request | undefined) =>
    request?.input
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.output);
  const ended = ends(s.requests[1]);
  assert.equal(ended?.[0], JSON.stringify({ id: "p1" }));
  assert.match(String(ended?.[1]), /No such placement/);
  // An agent that starts again reads them the same.
  await s.host.close();
  const again = await setup(values);
  await again.turn("And now?");
  assert.deepEqual(ends(again.requests[0]), ended);
});

test("a person's pictures reach the model with their message and stay in the chat; a tool's reach it with its call's output", async () => {
  const s = await setup();
  const png = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
  const jpeg = { mediaType: "image/jpeg" as const, data: "/9j/4AAQ" };
  s.actor.expose("camera", tools, {
    list: () => ({ tools: [{ name: "shoot", inputSchema: { type: "object" } }] }),
    call: async () => ({ output: "A screen.", images: [jpeg] }),
  });
  s.script.push(calls(callTool("camera__shoot", {}, "c1")));
  const from = s.actor.emitted.length;
  await s.chat("send", { text: "What is this?", images: [png] });
  await s.ended(from);
  const pictures = (request: Request | undefined) =>
    request?.input.flatMap((item) =>
      ((item.images as { data: string }[] | undefined) ?? []).map(({ data }) => data),
    );
  assert.deepEqual(pictures(s.whole[0]), [png.data]);
  assert.deepEqual(pictures(s.whole[1]), [png.data, jpeg.data]);
  const shown = s.actor.emitted.find((e) => e.event === "message")?.payload as {
    images?: unknown;
  };
  assert.deepEqual(shown.images, [png]);
  const { messages } = (await s.chat("history", {})) as { messages: { images?: unknown }[] };
  assert.deepEqual(
    messages.map((message) => message.images),
    [[png], undefined],
  );
  // A picture whose bytes aren't base64 is refused with its message.
  await assert.rejects(
    s.chat("send", { text: "And this?", images: [{ mediaType: "image/png", data: "not base64" }] }),
    (error: Error & { code?: string }) => error.code === "invalid",
  );
  // A picture sent by itself reaches the model with no words, and is shown so.
  const sentAt = s.actor.emitted.length;
  await s.chat("send", { images: [png] });
  await s.ended(sentAt);
  const alone = s.whole.at(-1)?.input.at(-1) as { content?: string; images?: { data: string }[] };
  assert.deepEqual(
    [alone.content?.replace(/^\[\d+\] /, ""), alone.images?.map(({ data }) => data)],
    ["", [png.data]],
  );
  const { messages: after } = (await s.chat("history", {})) as {
    messages: { role: string; text: string; images?: unknown }[];
  };
  const last = after.findLast((one) => one.role === "user");
  assert.deepEqual([last?.text, last?.images], ["", [png]]);
});

test("an agent talks to the agents whose conversations are exposed to it, from itself", async () => {
  const s = await setup();
  // Before any is exposed, it is offered nothing to talk to them with.
  await s.turn("Hello.");
  assert.ok(!s.whole[0]?.tools?.some((tool) => tool.name.startsWith("agents__")));
  const sent: { caller: string; text?: string }[] = [];
  const at = "2026-11-12T00:00:00Z";
  const long = (n: number, id: string) => ({
    id,
    role: "assistant" as const,
    text: "x".repeat(n),
    at,
  });
  // Found by whose it is, whatever its slot is named.
  const kid = { actor: "act_kid", export: "chat" };
  s.actor.expose(
    "anyName",
    chat,
    {
      send: ({ text }, { caller }) => {
        sent.push({ caller, ...(text === undefined ? {} : { text }) });
        return { messageId: "m1" };
      },
      history: ({ limit }) =>
        limit === 3
          ? { messages: [long(15_000, "m2"), long(15_000, "m3"), long(25_000, "m4")], more: false }
          : { messages: [{ id: "m1", role: "user" as const, text: "Start.", at }], more: false },
      state: () => ({ state: "working" as const }),
      list: () => ({
        conversations: [
          {
            with: "assistant",
            at,
            problem: { code: "usage_limit", message: "Usage limit reached." },
          },
        ],
        more: false,
      }),
    },
    kid,
  );
  s.script.push(
    calls(
      callTool("agents__send", { agent: "act_kid", text: "Start." }, "a1"),
      callTool("agents__read", { agent: "act_kid" }, "a2"),
      callTool("agents__send", { agent: "act_none", text: "Hi." }, "a3"),
      callTool("agents__read", { agent: "act_kid", limit: 3 }, "a4"),
    ),
  );
  await s.turn("Get the kid going.");
  // It is told the ids it can reach.
  const offeredSend = s.whole.at(-2)?.tools?.find((tool) => tool.name === "agents__send");
  const offeredIds = offeredSend?.parameters as
    | { properties: { agent: { enum: string[] } } }
    | undefined;
  assert.deepEqual(offeredIds?.properties.agent.enum, ["act_kid"]);
  // It sent from itself: the agent it made knows who speaks.
  assert.deepEqual(sent, [{ caller: "assistant", text: "Start." }]);
  const outputs = (s.requests.at(-1)?.input ?? [])
    .filter((item) => item.type === "function_call_output")
    .map((item) => String(item.output));
  assert.deepEqual(JSON.parse(outputs[0] ?? "{}"), { messageId: "m1" });
  assert.deepEqual(JSON.parse(outputs[1] ?? "{}"), {
    working: true,
    problem: { code: "usage_limit", message: "Usage limit reached." },
    messages: [{ id: "m1", role: "user", text: "Start.", at: "2026-11-12T00:00:00Z" }],
    more: false,
  });
  assert.match(outputs[2] ?? "", /You have no agent act_none/);
  // A read fits what a loop takes whole: a long message is cut, and the oldest go first.
  const fitted = JSON.parse(outputs[3] ?? "{}") as {
    messages: { id: string; text: string }[];
    more: boolean;
  };
  assert.deepEqual(
    fitted.messages.map((one) => [one.id, one.text.length]),
    [["m4", 20_000 + "… (5000 more characters)".length]],
  );
  assert.equal(fitted.more, true);
});

test("what is exposed to the agent becomes its tools at the next turn, and goes when removed", async () => {
  const s = await setup();
  const done: unknown[] = [];
  const parameters = { type: "object", properties: { quest: { type: "string" } } };
  s.actor.expose(
    "pocketSideQuests_quests",
    tools,
    {
      list: () => ({ tools: [{ name: "complete", inputSchema: parameters }] }),
      call: ({ arguments: args }) => {
        done.push(args.quest);
        return { output: "{}" };
      },
    },
    { actor: "act_quests", export: "tools" },
  );
  // A name a function tool can't have is left out, not sent.
  s.actor.expose("x".repeat(60), tools, listing({ list: () => ({}) }));
  // Only tools@1 slots are tools: another interface exposed to it offers none.
  s.actor.expose("other", other, { read: () => ({}) });
  s.script.push(
    calls(callTool("pocketSideQuests_quests__complete", { quest: "Water the plants" }, "c1")),
    say("Done."),
  );
  await s.turn("Mark the plants done.");
  assert.deepEqual(
    (s.requests[0]?.tools ?? []).map((tool) => tool.name),
    ["pocketSideQuests_quests__complete"],
  );
  assert.deepEqual(s.requests[0]?.tools?.[0]?.parameters, parameters);
  assert.deepEqual(done, ["Water the plants"]);
  s.actor.unexpose("pocketSideQuests_quests");
  await s.turn("And now?");
  assert.deepEqual(s.requests.at(-1)?.tools, []);
});

/** A tools@1 entry with an object schema. */
const entry = (name: string, description?: string) => ({
  name,
  ...(description ? { description } : {}),
  inputSchema: { type: "object" },
});
const offeredNames = (request: Request | undefined) => request?.tools?.map((tool) => tool.name);
const warnings = (s: Awaited<ReturnType<typeof setup>>) =>
  s.actor.logs.filter((line) => line.level === "warn" && /offered/.test(line.message));

test("a tools@1 slot's tools are offered by name, and what can't be is reported once", async () => {
  const s = await setup();
  const long = "t".repeat(70);
  s.actor.expose("first", tools, {
    list: () => ({
      tools: [entry("a.b/c", "d".repeat(2000)), entry("a_b_c"), entry(long)],
    }),
    call: () => ({ output: "" }),
  });
  await s.turn("hello");
  const offered = s.requests[0]?.tools as { name: string; description?: string }[];
  // A character a function name can't have becomes `_`; the name that then clashes is left out.
  assert.deepEqual(
    offered.map((tool) => tool.name),
    ["first__a_b_c"],
  );
  assert.equal(offered[0]?.description?.length, 1024);
  assert.deepEqual(warnings(s)[0]?.fields, {
    leftOut: [
      { slot: "first", tool: "a_b_c", reason: "duplicate" },
      { slot: "first", tool: long, reason: "name" },
    ],
  });
  await s.turn("again");
  assert.equal(warnings(s).length, 1);
});

test("a request offers at most what it can carry, the first given first", async () => {
  const s = await setup();
  const many = Array.from({ length: MAX_TOOLS + 2 }, (_, i) => entry(`t${i}`));
  s.actor.expose("big", tools, { list: () => ({ tools: many }), call: () => ({ output: "" }) });
  s.actor.expose("late", tools, {
    list: () => ({ tools: [entry("one")] }),
    call: () => ({ output: "" }),
  });
  await s.turn("hello");
  assert.equal(s.requests[0]?.tools?.length, MAX_TOOLS);
  // With the looper's own two, a request's most.
  assert.equal(s.whole[0]?.tools?.length, 128);
  assert.equal(offeredNames(s.requests[0])?.at(-1), `big__t${MAX_TOOLS - 1}`);
  assert.deepEqual(warnings(s)[0]?.fields, {
    leftOut: [
      { slot: "big", tool: `t${MAX_TOOLS}`, reason: "limit" },
      { slot: "big", tool: `t${MAX_TOOLS + 1}`, reason: "limit" },
      { slot: "late", tool: "one", reason: "limit" },
    ],
  });
});

test("tools past the request's bytes are left out too", async () => {
  const s = await setup();
  const wide = (name: string) => ({
    name,
    inputSchema: { type: "object", padding: "x".repeat(TOOLS_BUDGET / 2) },
  });
  s.actor.expose("wide", tools, {
    list: () => ({ tools: [wide("a"), wide("b"), wide("c")] }),
    call: () => ({ output: "" }),
  });
  await s.turn("hello");
  assert.deepEqual(offeredNames(s.requests[0]), ["wide__a"]);
});

test("a slot that can't list is left out with its code, and its tools return with it", async () => {
  const s = await setup();
  let down = true;
  s.actor.expose("flaky", tools, {
    list: () => {
      if (down) throw new NotConnected("flaky");
      return { tools: [entry("one")] };
    },
    call: () => ({ output: "" }),
  });
  await s.turn("down");
  assert.deepEqual(offeredNames(s.requests[0]), []);
  assert.deepEqual(warnings(s)[0]?.fields, {
    leftOut: [{ slot: "flaky", reason: "not_connected" }],
  });
  down = false;
  await s.turn("up");
  assert.deepEqual(offeredNames(s.requests[1]), ["flaky__one"]);
  assert.ok(s.actor.logs.some((line) => /offered to the model again/.test(line.message)));
});

test("a call that's refused, or whose connection went, reaches the model as its output", async () => {
  const s = await setup();
  s.actor.expose("flaky", tools, {
    list: () => ({ tools: [entry("one")] }),
    call: () => {
      throw new NotConnected("flaky");
    },
  });
  s.script.push(calls(callTool("flaky__one", {}, "c1")), say("It's down."));
  await s.turn("try");
  const output = s.requests[1]?.input.find((item) => item.type === "function_call_output");
  assert.match(String(output?.output), /not_connected/);
});

/** The settings an agent is given, in memory. */
function settingsOf(instructions: string, skills: { name: string; description: string }[]) {
  const files = new Map([
    ["review", "# Review\nRead the diff first."],
    ["review/notes.md", "Notes."],
  ]);
  return {
    get: () => ({ instructions, skills }),
    skill: ({ name, path }: { name: string; path?: string }) => {
      const text = files.get(path ? `${name}/${path}` : name);
      if (text === undefined) throw new Refused("unknown", "No such skill or file.");
      return { text };
    },
  };
}
const REVIEW = { name: "review", description: "Review a change." };

test("bound to settings, instructions and skills come from it, read at each request", async () => {
  const s = await setup();
  let skills = [REVIEW];
  s.actor.bind("settings", {
    ...settingsOf("You keep the docs.", []),
    get: () => ({ instructions: "You keep the docs.", skills }),
  });
  await s.turn("hello");
  const told = String(s.requests[0]?.instructions);
  assert.ok(told.startsWith("You keep the docs."));
  assert.ok(told.includes("- review: Review a change."));
  assert.ok(!told.includes(INSTRUCTIONS));
  assert.deepEqual(offeredNames(s.requests[0]), ["settings__skill"]);
  // Its main loop speaks as the agent: told its own instructions, and nothing of its skills.
  const front = String(s.routed[0]?.instructions);
  assert.ok(front.startsWith("You are the front desk."));
  assert.ok(front.endsWith("\n\nYou keep the docs."));
  assert.ok(!front.includes("review"));
  assert.deepEqual(offeredNames(s.routed[0]), ["route"]);

  // Removed: gone at the next request, and with no skills there's nothing to read them with.
  skills = [];
  await s.turn("again");
  assert.equal(s.requests[1]?.instructions, "You keep the docs.");
  assert.deepEqual(offeredNames(s.requests[1]), []);
});

test("the model reads a skill's text and files through settings", async () => {
  const s = await setup();
  s.actor.bind("settings", settingsOf("Do the work.", [REVIEW]));
  s.script.push(
    calls(
      callTool("settings__skill", { name: "review" }, "c1"),
      callTool("settings__skill", { name: "review", path: "notes.md" }, "c2"),
      callTool("settings__skill", { name: "review", path: "missing.md" }, "c3"),
    ),
    say("Read."),
  );
  await s.turn("review this");
  const outputs = new Map(
    (s.requests[1]?.input ?? [])
      .filter((item) => item.type === "function_call_output")
      .map((item) => [item.callId, String(item.output)]),
  );
  assert.equal(outputs.get("c1"), "# Review\nRead the diff first.");
  assert.equal(outputs.get("c2"), "Notes.");
  assert.match(outputs.get("c3") ?? "", /unknown/);
});

test("skills that won't fit the instructions are left out and reported", async () => {
  const s = await setup();
  const instructions = "x".repeat(MAX_INSTRUCTIONS - 600);
  const skills = ["a", "b"].map((name) => ({ name, description: "y".repeat(50) }));
  skills.push({ name: "c", description: "y".repeat(1000) });
  s.actor.bind("settings", settingsOf(instructions, skills));
  await s.turn("hello");
  assert.equal(s.requests.length, 1);
  const told = String(s.requests[0]?.instructions);
  assert.ok(told.length <= MAX_INSTRUCTIONS);
  assert.ok(!told.includes("- c:"));
  assert.deepEqual(warnings(s)[0]?.fields, {
    leftOut: [{ slot: "settings", tool: "c", reason: "limit" }],
  });
});

test("bound settings that can't answer end the turn rather than run it without its instructions", async () => {
  const s = await setup();
  s.actor.bind("settings", {
    get: () => {
      throw new NotConnected("settings");
    },
  });
  assert.equal((await s.turn("hello"))?.code, "not_connected");
  assert.equal(s.requests.length, 0);
});

test("with settings unbound, the instructions are the host's", async () => {
  const s = await setup();
  await s.turn("hello");
  assert.equal(s.requests[0]?.instructions, INSTRUCTIONS);
});

test("the model is chosen per agent, kept with it, and the provider's default until then", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  const offered = OFFERED;
  assert.deepEqual(await s.host.models(), { models: offered });
  await s.turn("With the default.");
  assert.equal(s.requests.at(-1)?.model, undefined);

  await s.host.setModel("gpt-b");
  assert.deepEqual(await s.host.models(), { models: offered, current: "gpt-b" });
  await s.turn("With the choice.");
  assert.equal(s.requests.at(-1)?.model, "gpt-b");
  await assert.rejects(s.host.setModel("gpt-z"), { code: "unknown" });

  // Kept with the agent, across a restart of its process.
  const again = await setup(values);
  assert.deepEqual(await again.host.models(), { models: offered, current: "gpt-b" });
  await again.host.setModel(undefined);
  await again.turn("Back to the default.");
  assert.equal(again.requests.at(-1)?.model, undefined);
});

test("a function call runs through its slot, and its result or refusal goes back", async () => {
  const s = await setup();
  const placed: unknown[] = [];
  s.actor.expose(
    "layout",
    tools,
    listing({
      remove: () => ({}),
      place: (input) => {
        placed.push(input);
        if (input.module === "logic") throw new Refused("invalid", "logic isn't a view module.");
        return { id: "p1" };
      },
      get: () => {
        throw new OutcomeUnknown();
      },
    }),
  );
  s.script.push(
    {
      output: [
        { type: "message", role: "assistant", content: "Placing it." },
        callTool("layout__place", { actor: "board", module: "panel" }, "c1"),
        callTool("layout__place", { actor: "board", module: "logic" }, "c2"),
      ],
    },
    calls(
      callTool("actors__list", {}, "c3"),
      { type: "function_call", callId: "c4", name: "layout__get", arguments: "{oops" },
      callTool("layout__get", {}, "c5"),
    ),
    (_request) => {
      // The slot goes away between the tool list and the call.
      s.actor.unexpose("layout");
      return calls({ ...callTool("layout__remove", { id: "p1" }, "c6") });
    },
    say("Placed the board."),
  );
  assert.equal(await s.turn("Show me the board."), undefined);
  assert.deepEqual(placed, [
    { actor: "board", module: "panel" },
    { actor: "board", module: "logic" },
  ]);
  const last = s.requests.at(-1)?.input ?? [];
  const outputs = Object.fromEntries(
    last
      .filter((item) => item.type === "function_call_output")
      .map((item) => [item.callId, JSON.parse(item.output as string)]),
  );
  assert.deepEqual(outputs.c1, { id: "p1" });
  assert.deepEqual(
    ["c2", "c3", "c4", "c5", "c6"].map((id) => outputs[id].error.code),
    ["invalid", "unknown_tool", "invalid", "outcome_unknown", "not_connected"],
  );
  // What it wrote beside its calls, and the calls, are its work's: the chat has what it sent.
  assert.deepEqual(s.messages(), ["user: Show me the board.", "assistant: Placed the board."]);
  assert.deepEqual(recorded(s), [
    "Show me the board.",
    "Placing it.",
    "layout__place: done",
    "layout__place: invalid",
    "actors__list: unknown_tool",
    "layout__get: invalid",
    "layout__get: outcome_unknown",
    "layout__remove: not_connected",
    "Placed the board.",
  ]);
  // Every call in the history has its output, right after it, as the Responses API needs.
  for (const [i, item] of last.entries())
    if (item.type === "function_call") assert.equal(last[i + 1]?.callId, item.callId);
});

test("a turn goes on for as many calls as it makes, and a stop still ends it", async () => {
  const s = await setup();
  let runs = 0;
  /** How many calls run before one waits, until it is let go. */
  let holdAt = 0;
  const held = gate();
  const go = gate();
  s.actor.expose(
    "layout",
    tools,
    listing({
      get: async () => {
        runs++;
        if (runs === holdAt) {
          held.open();
          await go.shut;
        }
        return { home: [] };
      },
    }),
  );
  /**
   * Say `text`, and wait for the turn's answer, the script's last step: `until` gives up long
   * before hundreds of calls are done.
   */
  const answered = async (text: string) => {
    const done = gate();
    s.script.push(() => {
      done.open();
      return say("Done.");
    });
    const from = s.actor.emitted.length;
    await s.chat("send", { text });
    await done.shut;
    return s.ended(from);
  };
  // Many calls, one request after another, and then the answer: no count ends the turn.
  const many = 300;
  for (let i = 0; i < many; i++) s.script.push(calls(callTool("layout__get", {})));
  assert.equal(await answered("Go on."), undefined);
  assert.equal(runs, many);
  assert.equal(s.requests.length, many + 1);
  // As many in one reply all run.
  s.script.push(
    calls(...Array.from({ length: many }, (_, i) => callTool("layout__get", {}, `m${i}`))),
  );
  runs = 0;
  assert.equal(await answered("All at once."), undefined);
  assert.equal(runs, many);
  // A turn that would go on is ended by a stop, and makes no request after it.
  const queued = many + 10;
  for (let i = 0; i < queued; i++) s.script.push(calls(callTool("layout__get", {})));
  runs = 0;
  holdAt = many + 1;
  await s.chat("send", { text: "Keep going." });
  await held.shut;
  const stopping = s.cut();
  go.open();
  await stopping;
  assert.equal(runs, many + 1);
  assert.equal(s.script.length, queued - (many + 1));
});

test("stopping the agent stops the model's response, and started again it takes a message at once", async () => {
  const s = await setup();
  const late = gate();
  // As the model Actor does, the cancelled response is refused `cancelled`.
  s.script.push(() =>
    late.shut.then(() => {
      throw new Refused("cancelled", "The response was cancelled.");
    }),
  );
  const from = s.actor.emitted.length;
  await s.chat("send", { text: "Think long." });
  await until(() => s.requests.length === 1, "the model request");
  await s.cut();
  assert.deepEqual(s.cancels, [s.requests[0]?.requestId]);
  assert.deepEqual(s.statuses(from).at(-1), { state: "idle" });
  // Not busy: a new turn starts while the old reply is still out.
  await s.turn("Next.");
  late.open();
  await s.host.settled();
  assert.deepEqual(s.messages(), ["user: Think long.", "user: Next.", "assistant: ok"]);
  // Being stopped isn't a failure.
  assert.equal(s.actor.logs.filter((line) => line.message.startsWith("A turn failed")).length, 0);
});

test("stopped before the model is asked, a turn never asks it", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  await s.turn("Hello.");
  const asked = s.requests.length;
  const saved = gate();
  const store = memory(values);
  s.actor.bind("store", {
    ...store.handlers,
    set: async (input) => {
      await saved.shut;
      return store.handlers.set(input);
    },
  });
  const sending = s.chat("send", { text: "Never mind." });
  await new Promise((resolve) => setImmediate(resolve));
  const cutting = s.cut();
  saved.open();
  await Promise.all([sending, cutting]);
  await s.host.settled();
  assert.equal(s.requests.length, asked);
});

test("stopped during a tool call, a turn keeps the call's real result and skips the calls after it", async () => {
  const s = await setup();
  const running = gate();
  const release = gate();
  let entered = 0;
  s.actor.expose(
    "layout",
    tools,
    listing({
      place: async () => {
        entered++;
        running.open();
        await release.shut;
        return { id: "p1" };
      },
    }),
  );
  s.script.push(
    calls(
      callTool("layout__place", { actor: "b", module: "panel" }, "g1"),
      callTool("layout__place", { actor: "b", module: "panel" }, "g2"),
    ),
    say("never"),
  );
  const from = s.actor.emitted.length;
  await s.chat("send", { text: "Place it twice." });
  await running.shut;
  const cutting = s.cut();
  await until(() => s.statuses(from).at(-1)?.state === "idle", "the agent to say it is idle");
  release.open();
  await cutting;
  await until(() => recorded(s).length === 3, "both calls recorded");
  assert.equal(entered, 1);
  assert.deepEqual(recorded(s).slice(1), ["layout__place: done", "layout__place: cancelled"]);
  assert.deepEqual(s.messages(), ["user: Place it twice."]);
  assert.equal(s.requests.length, 1, "no model call after the stop");
  // The next turn starts clean, with every call answered.
  await s.turn("Next.");
  const input = s.requests.at(-1)?.input ?? [];
  for (const [i, item] of input.entries())
    if (item.type === "function_call") assert.equal(input[i + 1]?.callId, item.callId);
});

test("a message sent in a chat whose turn is running is shown at once, and that turn answers it", async () => {
  const s = await setup();
  const first = gate<Reply>();
  s.script.push(() => first.shut, say("Both done."));
  const from = s.actor.emitted.length;
  await s.chat("send", { text: "First." });
  await until(() => s.requests.length === 1, "the model request");
  await s.chat("send", { text: "Second." });
  assert.deepEqual(s.messages(), ["user: First.", "user: Second."]);
  // The answer on its way didn't see it, so the turn goes round once more before it ends.
  first.open(say("First done."));
  assert.equal(await s.ended(from), undefined);
  assert.deepEqual(
    s.requests.map((request) => request.input.map((item) => item.content)),
    [["First."], ["First.", "First done.", "Second."]],
  );
  assert.deepEqual(s.messages(), [
    "user: First.",
    "user: Second.",
    "assistant: First done.",
    "assistant: Both done.",
  ]);
  await s.host.settled();
});

test("a turn cut off as the engine closes goes on in the next, and one the person stopped doesn't", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  await s.turn("Hello.");
  const marked = () => values.has(`loop/unfinished/${s.id()}`);
  assert.equal(marked(), false, "a turn that ended leaves no mark");
  const stopped = gate<Reply>();
  s.script.push(() => stopped.shut);
  await s.chat("send", { text: "Think." });
  await until(() => s.requests.length === 2, "the model request");
  assert.equal(marked(), true);
  await s.cut();
  stopped.open(say("Too late."));
  await s.host.settled();
  assert.equal(marked(), false, "stopped by the person");

  const cut = gate<Reply>();
  s.script.push(() => cut.shut);
  await s.chat("send", { text: "Do the long thing." });
  await until(() => s.requests.length === 3, "the model request");
  await s.host.close();
  cut.open(say("Too late."));
  await s.host.settled();
  assert.equal(marked(), true, "cut by the engine closing, as when the app restarts");

  const again = await setup(values);
  assert.equal(await again.ended(0), undefined);
  assert.deepEqual(
    again.requests[0]?.input.map((item) => item.content),
    [
      "Hello.",
      "ok",
      "Think.",
      "Do the long thing.",
      "This turn was cut off by a restart. Check what is already done before you repeat anything, then go on.",
    ],
  );
  // Its chat shows the reply; the line that says it went on is its work's.
  assert.deepEqual(again.messages(), ["assistant: ok"]);
  assert.ok(recorded(s).includes("Cut off by a restart: going on from where it stopped."));
  await again.host.settled();
  assert.equal(marked(), false);
  // The next start finds nothing to go on with.
  const third = await setup(values);
  await third.turn("And now?");
  assert.equal(third.requests.length, 1);
});

/** A store whose one chat is in a turn that was cut off as its engine closed. */
async function cutOff() {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  const cut = gate<Reply>();
  s.script.push(() => cut.shut);
  await s.chat("send", { text: "Do the long thing." });
  await until(() => s.requests.length === 1, "the model request");
  await s.host.close();
  cut.open(say("Too late."));
  await s.host.settled();
  return values;
}
const gone = (slot: string) => {
  throw new NotConnected(slot);
};
/** Nothing has gone on, and no chat says it will. */
async function waits(s: Awaited<ReturnType<typeof setup>>) {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.requests.length, 0);
  assert.deepEqual(s.messages(), []);
}
const WENT_ON = ["assistant: ok"];

test("a turn that was cut off waits for the agent's settings to answer, and goes on with them", async () => {
  // The agent is back before what holds its settings is running.
  let away = true;
  const s = await setup(await cutOff(), (actor) =>
    actor.bind("settings", {
      get: () => (away ? gone("settings") : { instructions: "Be kind.", skills: [] }),
    }),
  );
  await waits(s);
  away = false;
  s.actor.usable("settings");
  assert.equal(await s.ended(0), undefined);
  assert.equal(s.requests[0]?.instructions, "Be kind.");
  assert.deepEqual(s.messages(), WENT_ON);
  await s.host.settled();
});

test("a turn that was cut off waits for a tools slot that is away, and goes on with its tools or without the slot", async () => {
  for (const back of ["changed", "gone"] as const) {
    let away = true;
    let flaky: { emit(event: "changed", payload: object): void } | undefined;
    const s = await setup(await cutOff(), (actor) => {
      flaky = actor.expose("flaky", tools, {
        list: () => (away ? gone("flaky") : { tools: [entry("one")] }),
        call: () => ({ output: "" }),
      });
    });
    await waits(s);
    // Its server is up, and it says so; or the slot is taken from the agent.
    away = false;
    if (back === "changed") flaky?.emit("changed", {});
    else s.actor.unexpose("flaky");
    assert.equal(await s.ended(0), undefined);
    assert.deepEqual(offeredNames(s.requests[0]), back === "changed" ? ["flaky__one"] : []);
    assert.deepEqual(s.messages(), WENT_ON);
    await s.host.settled();
  }
});

test("what a worker sends streams into the chat as the reply it becomes; what it writes without sending doesn't", async () => {
  const s = await setup();
  const call = { id: "s1", name: "send" };
  s.script.push(async (request) => {
    s.model.emit("delta", { requestId: request.requestId, text: "Thinking" });
    for (const text of ['{"message":1,"text":"Hel', 'lo."}']) {
      s.model.emit("delta", { requestId: request.requestId, text, call });
      for (let i = 0; i < 20; i++) await new Promise((soon) => setImmediate(soon));
    }
    return {
      output: [
        ...write("Thinking it over.").output,
        {
          type: "function_call",
          callId: "s1",
          name: "send",
          arguments: '{"message":1,"text":"Hello."}',
        },
      ],
    };
  });
  await s.turn("Hi.");
  assert.deepEqual(s.messages(), ["user: Hi.", "assistant: Hello."]);
  const reply = s.actor.emitted
    .filter((e) => e.event === "message")
    .map((e) => e.payload as { id: string; role: string })
    .find((m) => m.role === "assistant");
  assert.deepEqual(
    s.actor.emitted.filter((e) => e.event === "delta").map((e) => e.payload),
    [
      { with: PERSON, id: reply?.id, text: "Hel" },
      { with: PERSON, id: reply?.id, text: "lo." },
    ],
  );
  // The next user message has a number of its own, never the reply's id.
  const next = (await s.chat("send", { text: "Again." })) as { messageId: string };
  assert.notEqual(next.messageId, reply?.id);
});

test("a refusal from the model is its chat's problem, with its code, until the chat's next reply", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  for (const code of ["usage_limit", "not_signed_in", "unavailable", "ineligible"]) {
    s.script.push(() => {
      throw new Refused(code, `refused: ${code}`);
    });
    // Told with the chat before the agent is said to be idle, and by its list after.
    const from = s.actor.emitted.length;
    assert.deepEqual(await s.turn("Try."), { code, message: `refused: ${code}` });
    const since = s.actor.emitted.slice(from);
    const told = since.findIndex((e) => (e.payload as { problem?: object }).problem !== undefined);
    const idle = since.findIndex((e) => (e.payload as { state?: string }).state === "idle");
    assert.ok(told !== -1 && told < idle, "a view never hears idle without the reason");
    assert.deepEqual((await listed(s)).conversations[0]?.problem, {
      code,
      message: `refused: ${code}`,
    });
  }
  assert.ok(s.actor.logs.some((line) => line.message.startsWith("A turn failed")));
  // It is kept with the conversation: an agent that starts again still tells it.
  await s.host.close();
  const again = await setup(values);
  const problem = async () =>
    (await listed(again)).conversations.find((one) => one.with === PERSON)?.problem;
  assert.equal((await problem())?.code, "ineligible");
  // Another party's reply is not the person's.
  await exchange(again, "Elsewhere.", "act_other");
  assert.equal((await problem())?.code, "ineligible");
  // A message is how one sends again: its turn reads what went unanswered too, and its reply
  // ends the problem.
  const from = again.actor.emitted.length;
  await sendAs(again, "Go on.");
  await until(() => again.statuses(from).some((one) => one.state === "idle"), "its turn to end");
  assert.equal(await problem(), undefined);
  assert.deepEqual(
    again.requests
      .at(-1)
      ?.input.slice(-2)
      .map((item) => item.content),
    ["Try.", "Go on."],
  );
});

test("a turn that ends without sending leaves its chat's problem: Not answered", async () => {
  const s = await setup();
  s.script.push(write("Thinking about it."));
  assert.deepEqual(await s.turn("First."), { code: "not_answered", message: "Not answered" });
});

test("a model that is not connected is the chat's problem too", async () => {
  const s = await setup();
  s.actor.unbind("model");
  assert.deepEqual(await s.turn("Anyone?"), {
    code: "not_connected",
    message: "model is not connected.",
  });
});

test("a long output keeps its head and its tail, and says how much was cut", () => {
  const short = "x".repeat(MAX_OUTPUT);
  assert.equal(capped(short), short);
  const cut = capped(`start${"x".repeat(100_000)}the error`);
  assert.ok(cut.startsWith("start") && cut.endsWith("the error"));
  assert.match(cut, /\n… \[70014 characters cut\] …\n/);
  // A surrogate pair across either cut is dropped whole, so the text stays well formed.
  // The offsets put a pair across both cuts.
  const emoji = capped(`a${"😀".repeat(40_000)}b`);
  assert.equal(Buffer.from(emoji).toString(), emoji);
});

test("outputs are capped, refusals too, and a long reply is shown in part", async () => {
  const s = await setup();
  s.actor.expose(
    "layout",
    tools,
    listing({
      remove: () => {
        throw new Refused("invalid", "x".repeat(250_000));
      },
    }),
  );
  const named = (name: string) => [
    {
      actorId: "a",
      name,
      package: "external" as const,
      state: "running" as const,
      connected: true,
      restarts: 0,
    },
  ];
  s.actor.expose("actors", tools, listing({ list: () => ({ actors: named("é".repeat(60_000)) }) }));
  const long = "y".repeat(150_000);
  s.script.push(
    calls(callTool("actors__list", {}, "a"), callTool("layout__remove", { id: "x" }, "b")),
    say(long),
  );
  assert.equal(await s.turn("Big."), undefined);
  const sent = s.requests.at(-1)?.input ?? [];
  const outputs = sent.filter((i) => i.type === "function_call_output");
  assert.equal(outputs.length, 2);
  for (const item of outputs) {
    assert.ok((item.output as string).length <= MAX_OUTPUT + 64);
    assert.match(item.output as string, /characters cut/);
  }
  const shown = s.actor.emitted
    .filter((e) => e.event === "message")
    .map((e) => e.payload as { role: string; text: string })
    .find((m) => m.role === "assistant");
  assert.equal(shown?.text.length, 100_000);
  // The record keeps the whole reply, and the chat still pages and goes on.
  await s.turn("Next.");
  assert.ok(s.requests.at(-1)?.input.some((item) => item.content === long));
  const page = (await s.chat("history", {})) as { messages: unknown[] };
  assert.ok(page.messages.length > 0);
});

test("history pages back, survives a restart, and skips what doesn't read back", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  for (let i = 1; i <= 5; i++) await s.turn(`Message ${i}.`);
  const page = (await s.chat("history", { limit: 4 })) as {
    messages: { id: string; text: string }[];
    more: boolean;
  };
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["Message 4.", "ok", "Message 5.", "ok"],
  );
  assert.equal(page.more, true);
  const older = (await s.chat("history", {
    before: page.messages[0]?.id,
    limit: 100,
  })) as {
    messages: unknown[];
    more: boolean;
  };
  assert.equal(older.messages.length, 6);
  assert.equal(older.more, false);
  assert.deepEqual(await s.chat("history", { before: "nothing-like-it" }), {
    messages: [],
    more: false,
  });

  // Another process, the same store, one record broken: it is left out, and nothing is overwritten.
  const keys = [...values.keys()].sort();
  values.set(keys[1] as string, { not: "an entry" });
  const restarted = await setup(values);
  const all = (await restarted.chat("history", { limit: 200 })) as {
    messages: unknown[];
  };
  assert.equal(all.messages.length, 9);
  await restarted.turn("After.");
  // Twelve messages and the conversation's entry.
  assert.equal(
    [...values.keys()].filter((key) => key.startsWith("chat/") || key.startsWith("conversations/"))
      .length,
    13,
  );
  assert.ok(restarted.actor.logs.some((line) => line.level === "warn"));
});

test("the model gets the opening message, a line for what was left out, and the newest whole exchanges that fit", async () => {
  const s = await setup();
  s.actor.expose("layout", tools, listing({ get: () => ({ home: [] }) }));
  s.script.push(calls(callTool("layout__get", {}, "first")));
  await s.turn("Message 1.");
  const bigs = Array.from({ length: 5 }, (_, i) => `${i}${"x".repeat(95_000)}`);
  for (const big of bigs) await s.turn(big);
  await s.turn("Small.");
  const sent = s.requests.at(-1)?.input ?? [];
  const texts = sent.map((item) => item.content as string);
  // What the work was asked stays, and what came between it and what is sent is one line.
  assert.equal(texts[0], "Message 1.");
  assert.match(texts[1] ?? "", /^\(Left out: /);
  assert.equal(
    sent.some((item) => item.callId === "first"),
    false,
    "the call left with the rest of its exchange",
  );
  assert.equal(texts.includes(bigs[0] as string), false);
  assert.equal(texts.includes(bigs[4] as string), true);
  assert.equal(texts.at(-1), "Small.");
  assert.ok(bytes(JSON.stringify(sent)) <= INPUT_BUDGET);
});

test("the next message still has a long turn, with its oldest outputs left out", async () => {
  const s = await setup();
  s.actor.expose("big", tools, listing({ read: () => "x".repeat(10_000) }));
  for (let i = 0; i < 60; i++) s.script.push(calls(callTool("big__read", {}, `c${i}`)));
  s.script.push(say("Done with the long part."));
  await s.turn("Do the long part.");
  s.script.push(say("Going on."));
  await s.turn("Go on.");
  const sent = s.requests.at(-1)?.input ?? [];
  assert.ok(bytes(JSON.stringify(sent)) <= INPUT_BUDGET + 20_000);
  const said = sent.filter((item) => item.type === "message").map((item) => item.content);
  assert.deepEqual(said, ["Do the long part.", "Done with the long part.", "Go on."]);
  const outputs = sent.filter((item) => item.type === "function_call_output");
  assert.equal(outputs.length, 60, "every call keeps an output");
  assert.match(outputs[0]?.output as string, /Left out/);
  assert.doesNotMatch(outputs.at(-1)?.output as string, /Left out/);
});

test("a latest exchange over the budget leaves out its oldest outputs, never a call", async () => {
  const s = await setup();
  s.actor.expose(
    "actors",
    tools,
    listing({
      list: () => ({
        actors: [
          {
            actorId: "a",
            name: "z".repeat(15_000),
            package: "external" as const,
            state: "running" as const,
            connected: true,
            restarts: 0,
          },
        ],
      }),
    }),
  );
  for (let i = 0; i < 20; i++) s.script.push(calls(callTool("actors__list", {}, `k${i}`)));
  s.script.push(say("done"));
  await s.turn("é".repeat(99_000));
  const big = s.requests.at(-1)?.input ?? [];
  assert.ok(bytes(JSON.stringify(big)) <= INPUT_BUDGET + 20_000);
  const outputs = big.filter((item) => item.type === "function_call_output");
  assert.equal(outputs.length, big.filter((item) => item.type === "function_call").length);
  assert.ok(outputs.some((item) => String(item.output).startsWith("(Left out")));
});

test("the calls of one reply cost one write each, however many", async () => {
  const writes = async (many: number) => {
    const s = await setup();
    s.actor.expose("layout", tools, listing({ get: () => ({ home: [] }) }));
    const done = gate();
    s.script.push(
      calls(...Array.from({ length: many }, (_, i) => callTool("layout__get", {}, `x${i}`))),
      () => {
        done.open();
        return say("Done.");
      },
    );
    const before = s.store.writes.count;
    const from = s.actor.emitted.length;
    await s.chat("send", { text: "Flood." });
    await done.shut;
    assert.equal(await s.ended(from), undefined);
    return s.store.writes.count - before;
  };
  // Whatever else a turn writes is the same however many calls it makes.
  assert.equal((await writes(300)) - (await writes(100)), 200);
});

test("a long message is stored once, under storage's value limit, and a big call is still kept", async () => {
  const s = await setup();
  s.actor.expose("layout", tools, listing({ get: () => ({ home: [] }) }));
  // 45,000 CJK characters are 135 KB of UTF-8: stored twice, they would pass 256 KiB.
  assert.equal(await s.turn("漢".repeat(45_000)), undefined);
  const big = { pad: "x".repeat(190_000) };
  s.script.push(calls(callTool("layout__get", big, "big")), say("done"));
  assert.equal(await s.turn("Big arguments."), undefined);
  for (const value of s.store.values.values())
    assert.ok(bytes(JSON.stringify(value)) <= VALUE_LIMIT);
  // The call ran and is recorded, its arguments left out of the record.
  const sent = s.requests.at(-1)?.input ?? [];
  const call = sent.find((item) => item.callId === "big");
  assert.ok(call);
  assert.match(call.arguments as string, /left_out/);
  assert.equal(
    sent.find((item) => item.type === "function_call_output" && item.callId === "big")?.output,
    '{"home":[]}',
  );
});

test("calls with large arguments never take a request past its budget", async () => {
  const s = await setup();
  s.actor.expose("layout", tools, listing({ get: () => ({ home: [] }) }));
  // Arguments, not outputs, fill this exchange: only leaving out old arguments keeps it in budget.
  for (let i = 0; i < 20; i++)
    s.script.push(calls(callTool("layout__get", { pad: "y".repeat(15_000) }, `a${i}`)));
  await s.turn("é".repeat(99_000));
  for (const request of s.requests)
    assert.ok(bytes(JSON.stringify(request.input)) <= INPUT_BUDGET + 20_000);
  const last = s.requests.at(-1)?.input ?? [];
  assert.equal(
    last.filter((item) => item.type === "function_call").length,
    last.filter((item) => item.type === "function_call_output").length,
  );
});

test("state says whether the agent is working, in any chat, for a view that opens late", async () => {
  const s = await setup();
  const state = () => s.actor.call("chat", "state", {});
  assert.deepEqual(await state(), { state: "idle" });
  const late = gate<Reply>();
  s.script.push(() => late.shut);
  const from = s.actor.emitted.length;
  await s.chat("send", { text: "Think." });
  await until(() => s.requests.length === 1, "the model request");
  assert.deepEqual(await state(), { state: "working" });
  // A second chat at work changes nothing anyone is told: the agent was working already.
  const other = gate<Reply>();
  s.script.push(() => other.shut);
  await s.actor.call("chat", "send", { text: "Think too." });
  await until(() => s.requests.length === 2, "the second request");
  late.open(say("Done."));
  await until(() => s.messages().includes("assistant: Done."), "the first reply");
  assert.deepEqual(await state(), { state: "working" });
  other.open(say("Done too."));
  await s.host.settled();
  assert.deepEqual(await state(), { state: "idle" });
  assert.deepEqual(s.statuses(from), [{ state: "working" }, { state: "idle" }]);

  // A failure leaves the agent idle too.
  s.script.push(() => {
    throw new Refused("usage_limit", "Usage limit reached.");
  });
  assert.equal((await s.turn("Again."))?.code, "usage_limit");
  assert.deepEqual(await state(), { state: "idle" });
});

type Listed = {
  with: string;
  at: string;
  latest?: { id: string; at: string; role: string; text: string };
  problem?: { code: string; message: string };
};
type Setup = Awaited<ReturnType<typeof setup>>;
/** The conversations, as `caller` lists them: the person, every one. */
const listed = (s: Setup, input: Record<string, unknown> = {}, caller = PERSON) =>
  s.actor.call("chat", "list", input, caller) as Promise<{
    conversations: Listed[];
    more: boolean;
  }>;
/** Send a message as `party`, and wait for its conversation's reply, or for its problem. */
async function exchange(s: Setup, text: string, party = PERSON) {
  const from = s.actor.emitted.length;
  const sent = (await s.actor.call("chat", "send", { text }, party)) as { messageId: string };
  type Told = { with?: string; role?: string; problem?: object };
  await until(() => {
    const since = s.actor.emitted.slice(from).map((e) => ({ ...e, told: e.payload as Told }));
    // The conversation's entry is said once for the message itself, with whatever it had before.
    const own = since.findIndex((e) => e.event === "chat" && e.told.with === party);
    return since.some((e, i) =>
      e.event === "chat"
        ? i > own && e.told.with === party && e.told.problem !== undefined
        : e.event === "message" && e.told.with === party && e.told.role === "assistant",
    );
  }, "the conversation to be answered");
  return sent;
}
/** A conversation's messages, as the person reads them. */
const shownIn = async (s: Setup, party: string) =>
  (
    (await s.actor.call("chat", "history", { with: party }, PERSON)) as {
      messages: { id: string; role: string; text: string }[];
    }
  ).messages;
/** Send a message as `party`, without waiting for its answer. */
const sendAs = (s: Setup, text: string, party = PERSON) =>
  s.actor.call("chat", "send", { text }, party) as Promise<{ messageId: string }>;

test("each party's first message begins its conversation with the agent, with a record of its own", async () => {
  const s = await setup();
  s.script.push(say("About trees."), say("About boats."), say("More trees."));
  await exchange(s, "Tell me about trees.");
  await exchange(s, "Boats now.", "act_b");
  let { conversations, more } = await listed(s);
  assert.equal(more, false);
  assert.deepEqual(
    conversations.map((one) => [one.with, one.latest?.text]),
    [
      ["act_b", "About boats."],
      [PERSON, "About trees."],
    ],
  );
  // Anyone else lists only their own, and reads only their own.
  assert.deepEqual(
    (await listed(s, {}, "act_b")).conversations.map((one) => one.with),
    ["act_b"],
  );
  await assert.rejects(s.actor.call("chat", "history", { with: PERSON }, "act_b"), {
    code: "forbidden",
  });
  // One that hasn't begun has nothing.
  assert.deepEqual(await s.actor.call("chat", "history", {}, "act_none"), {
    messages: [],
    more: false,
  });
  // Its latest is its newest message.
  const reply = (await shownIn(s, PERSON)).at(-1);
  assert.equal(reply?.text, "About trees.");
  assert.equal(conversations[1]?.latest?.id, reply?.id);
  // The model is sent one conversation, never the other, and told who spoke, when not the person.
  assert.deepEqual(
    s.requests[1]?.input.map((item) => item.content),
    ["(from act_b) Boats now."],
  );
  // A conversation's record is kept under its own thread, which its entry names, a key per message.
  const thread = s.id("act_b");
  assert.notEqual(thread, "act_b");
  assert.deepEqual(
    [...s.store.values.keys()].filter((key) => key.startsWith(`chat/${thread}/`)),
    [`chat/${thread}/msg/000000000001`, `chat/${thread}/msg/000000000002`],
  );
  await exchange(s, "Go on.");
  assert.deepEqual(
    s.requests[2]?.input.map((item) => item.content),
    ["Tell me about trees.", "About trees.", "Go on."],
  );
  // The conversation a message was sent in comes first.
  ({ conversations } = await listed(s));
  assert.deepEqual(
    conversations.map((one) => one.with),
    [PERSON, "act_b"],
  );
  // Each event names who its conversation is with, and goes to them and to the person; the
  // agent's status names none and goes to all.
  for (const e of s.actor.emitted.filter((one) => one.export === "chat")) {
    const payload = e.payload as { with?: string };
    if (e.event === "status") assert.deepEqual([payload.with, e.to], [undefined, undefined]);
    else assert.ok(e.to === payload.with || e.to === PERSON, `${e.event} to ${e.to}`);
  }
  assert.ok(
    s.actor.emitted.some(
      (e) => e.event === "message" && (e.payload as Listed).with === "act_b" && e.to === PERSON,
    ),
  );
  const said = s.actor.emitted
    .filter((e) => e.event === "chat" && e.to === PERSON)
    .map((e) => e.payload as Listed);
  assert.deepEqual(said.at(-1), conversations[0]);
});

test("an agent answers several parties at once, and past its places a conversation waits its turn", async () => {
  const s = await setup();
  await exchange(s, "One.");
  await exchange(s, "Two.", "act_two");
  const late = gate<Reply>();
  s.script.push(() => late.shut);
  await sendAs(s, "Think.");
  await until(() => s.requests.length === 3, "the model request");
  // Another party is answered meanwhile, and a third begins.
  await exchange(s, "Me too.", "act_two");
  await exchange(s, "A third.", "act_three");
  assert.equal((await shownIn(s, "act_three")).at(-1)?.text, "ok");
  assert.deepEqual(await s.actor.call("chat", "state", {}), { state: "working" });

  // With four turns running, a new party's message is taken and shown, and its turn waits.
  const others = [gate<Reply>(), gate<Reply>(), gate<Reply>()];
  for (const [i, other] of others.entries()) {
    s.script.push(() => other.shut);
    await sendAs(s, "Think too.", `act_other${i}`);
  }
  await until(() => s.requests.length === 8, "four turns running");
  await sendAs(s, "And me.", "act_waits");
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.requests.length, 8, "nothing is asked of the model for it yet");
  assert.deepEqual(
    (await shownIn(s, "act_waits")).map((m) => m.text),
    ["And me."],
  );
  late.open(say("Done."));
  await until(() => s.requests.length === 9, "the turn that waited");
  for (const other of others) other.open(say("Done too."));
  await s.host.settled();
  assert.equal((await shownIn(s, "act_waits")).at(-1)?.text, "ok");
});

test("a plain message is answered by the agent's main loop, in its conversation, which is no work's", async () => {
  const s = await setup();
  s.routing.says = "Hello. What can I do?";
  const from = s.actor.emitted.length;
  await sendAs(s, "Hi.");
  await s.host.settled();
  const emitted = s.actor.emitted.slice(from);
  assert.deepEqual(
    emitted.flatMap(({ event, payload }) =>
      event === "message"
        ? [`${(payload as { role: string }).role}: ${(payload as { text: string }).text}`]
        : [],
    ),
    ["user: Hi.", "assistant: Hello. What can I do?"],
  );
  assert.deepEqual(
    emitted.flatMap(({ event, payload }) =>
      event === "status" ? [(payload as { state: string }).state] : [],
    ),
    ["working", "idle"],
  );
  assert.equal(s.requests.length, 0, "no worker was asked");
  // With no settings bound it speaks as the agent's standing instructions say.
  assert.ok(String(s.routed[0]?.instructions).endsWith(`\n\n${INSTRUCTIONS}`));
  // The next message there is put to the main loop again, with what was said.
  s.routing.says = "Still here.";
  await sendAs(s, "Still there?");
  await s.host.settled();
  assert.deepEqual(
    s.routed[1]?.input.map((item) => item.content),
    ["There is no work.", "Hi.", "Hello. What can I do?", "Still there?"],
  );
  assert.deepEqual(
    (await shownIn(s, PERSON)).map((message) => message.text),
    ["Hi.", "Hello. What can I do?", "Still there?", "Still here."],
  );
});

test("another party's message is given only to work that follows its conversation, never to the person's", async () => {
  const s = await setup();
  const late = gate<Reply>();
  s.script.push(() => late.shut, say("Chart added."));
  await sendAs(s, "Write the report.");
  await until(() => s.requests.length === 1, "the person's work's request");
  // The main loop names the person's work: it isn't one it was told of, so the message starts new
  // work.
  s.routing.to = JSON.stringify({ work: s.id() });
  await sendAs(s, "Add a chart.", "act_two");
  await until(() => s.routed.length === 2, "the main loop to be asked");
  assert.deepEqual(
    s.routed[1]?.input.map((item) => item.content),
    ["There is no work.", "(from act_two) Add a chart."],
  );
  // Its request is the looper's own words, who the agent is, and one function: none of its tools.
  assert.match(String(s.routed[1]?.instructions), /^You are the front desk\./);
  assert.deepEqual(
    s.routed[1]?.tools?.map((tool) => tool.name),
    ["route"],
  );
  late.open(say("Report done."));
  await s.host.settled();
  assert.deepEqual(
    (await shownIn(s, PERSON)).map((m) => m.text),
    ["Write the report.", "Report done."],
  );
  assert.deepEqual(
    (await shownIn(s, "act_two")).map((m) => m.text),
    ["Add a chart.", "Chart added."],
  );
  // The person's work never read it.
  assert.ok(
    !s.requests.some(
      (one, i) =>
        i !== 1 && one.input.some((item) => String(item.content).includes("Add a chart.")),
    ),
  );
});

test("saying stop in a conversation whose work is in a turn stops that turn, and no other work's", async () => {
  const s = await setup();
  const report = gate<Reply>();
  const chart = gate<Reply>();
  s.script.push(
    () => report.shut,
    () => chart.shut,
  );
  await sendAs(s, "Write the report.");
  await until(() => s.requests.length === 1, "the first work's request");
  await sendAs(s, "Draw the chart.", "act_two");
  await until(() => s.requests.length === 2, "the second work's request");
  // The main loop hears of a message said to work in a turn, in its own words alone, and stops it.
  s.routing.to = JSON.stringify({ stop: s.id() });
  s.routing.says = "Stopped the report.";
  await sendAs(s, "Stop.");
  await until(() => s.cancels.length === 1, "the turn to be cut");
  assert.deepEqual(s.cancels, [s.requests[0]?.requestId]);
  assert.match(
    String(s.routed[2]?.instructions),
    /^You are the front desk\. You are given the pieces of work that are in a turn/,
  );
  assert.doesNotMatch(String(s.routed[2]?.instructions), /you speak as/);
  report.open(say("Report done."));
  chart.open(say("Chart done."));
  await s.host.settled();
  assert.deepEqual(
    (await shownIn(s, PERSON)).map((m) => m.text),
    ["Write the report.", "Stop.", "Stopped the report."],
  );
  assert.deepEqual(
    (await shownIn(s, "act_two")).map((m) => m.text),
    ["Draw the chart.", "Chart done."],
  );
});

test("a message its conversation's work hands back is taken up by new work in the same conversation, and both follow it", async () => {
  const s = await setup();
  /** The number the newest message of the request the model just got starts with. */
  const newest = () =>
    Number(
      /^\[(\d+)\] /.exec(
        String(s.whole.at(-1)?.input.findLast((item) => item.role === "user")?.content),
      )?.[1],
    );
  s.script.push(
    say("Report done."),
    () => ({
      output: [callTool("hand_back", { message: newest(), why: "It asks about the weather." })],
    }),
    say("Sunny."),
  );
  await sendAs(s, "Write the report.");
  await s.host.settled();
  // A worker's request is the agent's own, then the looper's part: which work it is, each
  // message by its number, and the function to hand one back.
  assert.match(String(s.whole[0]?.instructions), /\n\nThis is one piece of work: Work\. /);
  assert.equal(s.whole[0]?.tools?.at(-1)?.name, "hand_back");
  assert.deepEqual(
    s.whole[0]?.input.map((item) => item.content),
    ["[1] Write the report."],
  );
  await sendAs(s, "What is the weather?");
  await s.host.settled();
  // The main loop is given what came back, with the work that returned it and why.
  assert.match(
    String(s.routed[1]?.input.at(-1)?.content),
    /^That was given to this work, which handed it back:\n- .*: Work; because: It asks about the weather\.$/,
  );
  // The new work reads it as its first message, and answers in the same chat; the handing back
  // is shown to nobody.
  assert.deepEqual(
    s.whole[2]?.input.map((item) => item.content),
    ["[1] What is the weather?"],
  );
  assert.deepEqual(
    (await shownIn(s, PERSON)).map((m) => m.text),
    ["Write the report.", "Report done.", "What is the weather?", "Sunny."],
  );
  // The chat's next message reaches both.
  await sendAs(s, "Thanks.");
  await s.host.settled();
  assert.equal(s.requests.length, 5);
});

test("a closing engine cuts its turns and starts no other", async () => {
  const s = await setup();
  await exchange(s, "One.");
  const late = gate<Reply>();
  s.script.push(() => late.shut);
  await sendAs(s, "Think.");
  await until(() => s.requests.length === 2, "the model request");
  await s.host.close();
  assert.equal(s.cancels.length, 1);
  const closing = { code: "unavailable" };
  await assert.rejects(sendAs(s, "More."), closing);
  await assert.rejects(sendAs(s, "Something new.", "act_new"), closing);
  assert.equal((await listed(s)).conversations.length, 1);
  late.open(say("Too late."));
  await s.host.settled();
  assert.deepEqual(
    (await shownIn(s, PERSON)).map((m) => m.text),
    ["One.", "ok", "Think."],
  );
});

test("a stopped agent's conversations are read and kept as they are, and take nothing until it starts", async () => {
  const s = await setup();
  await exchange(s, "One.");
  await exchange(s, "Two.", "act_two");
  const late = gate<Reply>();
  s.script.push(() => late.shut);
  await sendAs(s, "Think.", "act_two");
  await until(() => s.requests.length === 3, "the model request");
  await s.host.stop();
  assert.equal(s.cancels.length, 1, "its turn is cut");
  late.open(say("Too late."));
  await s.host.settled();

  const stopped = { code: "busy", message: /It is stopped/ };
  await assert.rejects(sendAs(s, "More.", "act_two"), stopped);
  await assert.rejects(sendAs(s, "Something new.", "act_new"), stopped);
  // Each is listed where it was, and can be read.
  assert.deepEqual(
    (await listed(s)).conversations.map((one) => one.with),
    ["act_two", PERSON],
  );
  assert.deepEqual(
    (await shownIn(s, "act_two")).map((m) => m.text),
    ["Two.", "ok", "Think."],
  );
  s.host.start();
  await exchange(s, "Go on.", "act_two");
});

test("the conversations are listed a page at a time, the one last written in first", async () => {
  const s = await setup();
  const made: string[] = [];
  for (let i = 1; i <= 5; i++) {
    await exchange(s, `Message ${i}.`, `act_${i}`);
    made.unshift(`act_${i}`);
  }
  const ids = (page: { conversations: Listed[] }) => page.conversations.map((one) => one.with);
  const first = await listed(s, { limit: 2 });
  assert.deepEqual([ids(first), first.more], [made.slice(0, 2), true]);
  const next = await listed(s, { before: made[1], limit: 2 });
  assert.deepEqual([ids(next), next.more], [made.slice(2, 4), true]);
  const last = await listed(s, { before: made[3], limit: 2 });
  assert.deepEqual([ids(last), last.more], [made.slice(4), false]);
  assert.deepEqual(await listed(s, { before: "no-such" }), { conversations: [], more: false });

  // One moves to the front while a reader pages: the next page leaves out none that didn't.
  const [newest, second, third, fourth, oldest] = made as [string, string, string, string, string];
  await exchange(s, "Once more.", oldest);
  assert.equal((await listed(s, { limit: 1 })).conversations[0]?.with, oldest);
  assert.deepEqual(ids(await listed(s, { before: second, limit: 2 })), [third, fourth]);
  // The reader's last one moved: the page repeats what now follows it.
  await exchange(s, "And again.", second);
  assert.deepEqual(ids(await listed(s, { before: second })), [oldest, newest, third, fourth]);
});

/** A message as it was kept before an agent had chats. */
const formerly = (seq: number, role: "user" | "assistant", content: string) => {
  const key = String(seq).padStart(12, "0");
  return [
    `msg/${key}`,
    {
      id: role === "user" ? key : `reply-${seq}`,
      role,
      at: `2026-11-01T10:00:0${seq}.000Z`,
      items: [{ type: "message", role, content }],
    },
  ] as const;
};

test("the conversation an agent had before it had chats becomes the person's", async () => {
  const values = new Map<string, unknown>([
    formerly(1, "user", "Plan the week.\nStart on Monday."),
    formerly(2, "assistant", "Planned."),
    formerly(3, "user", "Thanks."),
    formerly(4, "assistant", "Any time."),
    ["settings/model", "gpt-b"],
  ]);
  const s = await setup(values);
  assert.deepEqual(await listed(s), {
    conversations: [
      {
        with: PERSON,
        at: "2026-11-01T10:00:01.000Z",
        latest: {
          id: "reply-4",
          at: "2026-11-01T10:00:04.000Z",
          role: "assistant",
          text: "Any time.",
        },
      },
    ],
    more: false,
  });
  assert.deepEqual(
    (await shownIn(s, PERSON)).map((m) => `${m.role}: ${m.text}`),
    [
      "user: Plan the week.\nStart on Monday.",
      "assistant: Planned.",
      "user: Thanks.",
      "assistant: Any time.",
    ],
  );
  assert.deepEqual(
    [...values.keys()].filter(
      (key) => !key.startsWith("chat/") && !key.startsWith("conversations/"),
    ),
    ["settings/model"],
  );
  assert.equal((await s.host.models()).current, "gpt-b");
  // It goes on from where it was.
  const sent = await exchange(s, "One more thing.");
  assert.equal(sent.messageId, "000000000005");
  assert.equal(s.requests[0]?.input.length, 5);
});

test("a move to the first chat that was cut short goes on, with the entry it began with", async () => {
  const [one, two, three, four] = [
    formerly(1, "user", "Plan the week."),
    formerly(2, "assistant", "Planned."),
    formerly(3, "user", "Thanks."),
    formerly(4, "assistant", "Any time."),
  ];
  const entry = {
    title: "Plan the week.",
    at: "2026-11-01T10:00:01.000Z",
    order: 0,
    latest: { id: "reply-4", at: "2026-11-01T10:00:04.000Z" },
    archived: false,
  };
  const values = new Map<string, unknown>([
    ["chats/first", entry],
    [`chat/first/${one[0]}`, one[1]],
    [`chat/first/${two[0]}`, two[1]],
    three,
    four,
  ]);
  const s = await setup(values);
  assert.equal((await listed(s)).conversations[0]?.at, "2026-11-01T10:00:01.000Z");
  assert.deepEqual(
    (await shownIn(s, PERSON)).map((m) => m.text),
    ["Plan the week.", "Planned.", "Thanks.", "Any time."],
  );
  assert.ok(![...values.keys()].some((key) => key.startsWith("msg/") || key.startsWith("chats/")));
});

test("a first chat's entry that doesn't read back is made again, and the conversation takes a message", async () => {
  const values = new Map<string, unknown>([
    ["chats/first", { not: "an entry" }],
    formerly(1, "assistant", "Hello. What shall we do?"),
  ]);
  const s = await setup(values);
  assert.deepEqual(
    (await listed(s)).conversations.map((one) => [one.with, one.latest?.text]),
    [[PERSON, "Hello. What shall we do?"]],
  );
  assert.equal((await exchange(s, "Plan the week.")).messageId, "000000000002");
});

/** A chat's entry as an agent kept it before it had one conversation with each party. */
const chatBefore = (id: string, order: number) =>
  [
    `chats/${id}`,
    { title: id, at: `2026-11-0${order}T10:00:00.000Z`, order, archived: false },
  ] as const;
/** A message of a chat's record, as kept then, on that day of the month. */
const saidBefore = (
  id: string,
  day: number,
  seq: number,
  role: "user" | "assistant",
  content: string,
) =>
  [
    `chat/${id}/msg/${String(seq).padStart(12, "0")}`,
    {
      id: `${id}-${seq}`,
      role,
      at: `2026-11-0${day}T10:00:0${seq}.000Z`,
      items: [{ type: "message", role, content }],
    },
  ] as const;

test("on upgrade the person's chat last written in becomes their conversation, and every other chat goes, with work that followed only those", async () => {
  const values = new Map<string, unknown>([
    chatBefore("c1", 1),
    saidBefore("c1", 1, 1, "user", "Plan the week."),
    saidBefore("c1", 1, 2, "assistant", "Planned."),
    chatBefore("c2", 2),
    saidBefore("c2", 3, 1, "user", "Write the report."),
    saidBefore("c2", 3, 2, "assistant", "Report written."),
    // Another agent's, written in last: never the person's.
    chatBefore("m1", 3),
    saidBefore("m1", 4, 1, "user", 'An agent, "Boss", says:\n\nCheck the logs.'),
    ["loop/work/c1", { title: "Plan", follows: ["c1"] }],
    ["loop/work/m1", { title: "Logs", follows: ["m1"] }],
    ["loop/unfinished/m1", true],
    ["loop/work/c2", { title: "Report", follows: ["c2"] }],
    ["loop/work/both", { title: "Both", follows: ["c1", "c2"], left: ["c1"] }],
    // Left with only a thread it has left, it is given nothing more: it goes too.
    ["loop/work/lefty", { title: "Lefty", follows: ["c1", "c2"], left: ["c2"] }],
    ["loop/unrouted/c1", false],
  ]);
  const s = await setup(values);
  assert.deepEqual(await listed(s), {
    conversations: [
      {
        with: PERSON,
        at: "2026-11-02T10:00:00.000Z",
        latest: {
          id: "c2-2",
          at: "2026-11-03T10:00:02.000Z",
          role: "assistant",
          text: "Report written.",
        },
      },
    ],
    more: false,
  });
  assert.deepEqual(
    (await shownIn(s, PERSON)).map((m) => m.text),
    ["Write the report.", "Report written."],
  );
  // Nothing is left of the others: their entries, records and marks, and work that followed only
  // them.
  assert.deepEqual([...values.keys()].filter((key) => !key.startsWith("chat/c2/")).sort(), [
    "conversations/person",
    "loop/work/both",
    "loop/work/c2",
  ]);
  assert.deepEqual(values.get("loop/work/both"), { title: "Both", follows: ["c2"] });
  assert.ok(
    s.actor.logs.some(
      (line) =>
        line.message ===
        "One conversation per party: kept 1, deleted 2 chats and 3 pieces of work.",
    ),
  );
  // It is done once: an agent that starts again finds one conversation and changes nothing.
  const kept = new Map(values);
  const again = await setup(values);
  assert.equal((await listed(again)).conversations.length, 1);
  assert.deepEqual(values, kept);
  // And it goes on in it: both pieces of work that follow it are given the message.
  await exchange(again, "Add a chart.");
  await again.host.settled();
  assert.deepEqual(
    (await shownIn(again, PERSON)).map((m) => m.text),
    ["Write the report.", "Report written.", "Add a chart.", "ok", "ok"],
  );
});

test("an upgrade cut short goes on at the next start, choosing as it did", async () => {
  const values = new Map<string, unknown>([
    // Begun by another agent, the person writing in it last: never the person's, even half deleted.
    chatBefore("m1", 1),
    saidBefore("m1", 1, 1, "user", 'An agent, "Boss", says:\n\nCheck the logs.'),
    saidBefore("m1", 4, 2, "user", "Also this."),
    chatBefore("c2", 2),
    saidBefore("c2", 2, 1, "user", "Write the report."),
  ]);
  const s = await setup(values);
  const store = memory(values);
  let deleted = 0;
  s.actor.bind("store", {
    ...store.handlers,
    delete: (input) => {
      if (input.key.startsWith("chat/m1/") && ++deleted === 2)
        throw new Refused("unavailable", "The store is away.");
      return store.handlers.delete(input);
    },
  });
  await assert.rejects(listed(s), { code: "unavailable" });
  const again = await setup(values);
  assert.deepEqual(
    (await shownIn(again, PERSON)).map((m) => m.text),
    ["Write the report."],
  );
  assert.ok(
    ![...values.keys()].some((key) => key.startsWith("chats/") || key.startsWith("chat/m1/")),
  );
});

test("an upgrade run again after a rollback weighs the chats there against the conversation, by their newest message", async () => {
  // A chat made on the version rolled back to, after the conversation's newest message, wins.
  const values = new Map<string, unknown>([
    ["conversations/person", { thread: "kept", at: "2026-11-01T10:00:00.000Z", order: 1 }],
    saidBefore("kept", 1, 1, "user", "Plan the week."),
    chatBefore("since", 2),
    saidBefore("since", 2, 1, "user", "Write the report."),
  ]);
  const s = await setup(values);
  assert.deepEqual(
    (await shownIn(s, PERSON)).map((m) => m.text),
    ["Write the report."],
  );
  assert.ok(![...values.keys()].some((key) => key.startsWith("chat/kept/")));
  // One older than the conversation goes.
  const older = new Map<string, unknown>([
    ["conversations/person", { thread: "kept", at: "2026-11-01T10:00:00.000Z", order: 5 }],
    saidBefore("kept", 5, 1, "user", "Plan the week."),
    chatBefore("old", 2),
    saidBefore("old", 2, 1, "user", "Write the report."),
  ]);
  const t = await setup(older);
  assert.deepEqual(
    (await shownIn(t, PERSON)).map((m) => m.text),
    ["Plan the week."],
  );
  assert.ok(
    ![...older.keys()].some((key) => key.startsWith("chat/old/") || key.startsWith("chats/")),
  );
});

test("a party's first messages at once make one conversation, and one that fails leaves the next to make it", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  await Promise.all([sendAs(s, "One.", "act_x"), sendAs(s, "Two.", "act_x")]);
  await s.host.settled();
  assert.deepEqual(
    (await listed(s)).conversations.map((one) => one.with),
    ["act_x"],
  );
  assert.deepEqual(
    (await shownIn(s, "act_x")).filter((m) => m.role === "user").map((m) => m.text),
    ["One.", "Two."],
  );
  // A first message the store refuses, with another waiting behind it: that one makes it.
  const store = memory(values);
  let refused = false;
  s.actor.bind("store", {
    ...store.handlers,
    set: (input) => {
      if (input.key.includes("/msg/") && !refused) {
        refused = true;
        throw new Refused("quota", "The store is full.");
      }
      return store.handlers.set(input);
    },
  });
  const [first, second] = await Promise.allSettled([
    sendAs(s, "Three.", "act_y"),
    sendAs(s, "Four.", "act_y"),
  ]);
  assert.equal(first.status, "rejected");
  assert.equal(second.status, "fulfilled");
  await s.host.settled();
  assert.equal((await listed(s)).conversations.filter((one) => one.with === "act_y").length, 1);
  assert.deepEqual(
    (await shownIn(s, "act_y")).filter((m) => m.role === "user").map((m) => m.text),
    ["Four."],
  );
});

test("a first message that can't be recorded begins no conversation, and leaves the agent free", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  const store = memory(values);
  s.actor.bind("store", {
    ...store.handlers,
    set: (input) => {
      if (input.key.includes("/msg/")) throw new Refused("quota", "The store is full.");
      return store.handlers.set(input);
    },
  });
  await assert.rejects(sendAs(s, "Hello."), { code: "quota" });
  assert.deepEqual(await listed(s), { conversations: [], more: false });
  assert.deepEqual([...values.keys()], []);
  assert.equal(s.actor.emitted.length, 0);
  s.actor.bind("store", store.handlers);
  assert.ok((await exchange(s, "Hello again.")).messageId);
});

test("a reply the store refuses is the chat's problem, with the store's own code", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  const store = memory(values);
  s.actor.bind("store", {
    ...store.handlers,
    set: (input) => {
      if (input.key.endsWith("/msg/000000000002")) throw new Refused("quota", "The store is full.");
      return store.handlers.set(input);
    },
  });
  assert.deepEqual(await s.turn("Hello."), { code: "quota", message: "The store is full." });
});

test("a chat's messages asked for while the store can't be read fail with the store's own error", async () => {
  const values = new Map<string, unknown>();
  await exchange(await setup(values), "Hello.");
  // A start later: the conversation's record isn't read until it is asked for.
  const s = await setup(values);
  await listed(s);
  const store = memory(values);
  const away = (error: Error) =>
    s.actor.bind("store", {
      ...store.handlers,
      list: () => {
        throw error;
      },
    });
  away(new Refused("unavailable", "The store is away."));
  await assert.rejects(s.chat("history"), {
    name: "Refused",
    code: "unavailable",
    message: "The store is away.",
  });
  away(new NotConnected("store"));
  await assert.rejects(s.chat("history"), { name: "NotConnected" });
  s.actor.bind("store", store.handlers);
  assert.deepEqual(
    (await shownIn(s, PERSON)).map((m) => m.text),
    ["Hello.", "ok"],
  );
});

test("a reply being recorded as its turn is stopped is still its chat's newest", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  const store = memory(values);
  const writing = gate();
  const written = gate();
  s.actor.bind("store", {
    ...store.handlers,
    set: async (input) => {
      if (input.key.endsWith("/msg/000000000002")) {
        writing.open();
        await written.shut;
      }
      return store.handlers.set(input);
    },
  });
  s.script.push(say("Just in time."));
  await s.chat("send", { text: "Hello." });
  await writing.shut;
  const stopping = s.host.stop();
  written.open();
  await stopping;
  await s.host.settled();
  const [chat] = (await listed(s)).conversations;
  const reply = (await shownIn(s, PERSON)).at(-1);
  assert.equal(reply?.text, "Just in time.");
  assert.equal(chat?.latest?.id, reply?.id);
});

test("Work answers what each piece of work did, while the agent runs and once it is stopped, and says when that changed", async () => {
  const s = await setup();
  s.actor.expose("layout", tools, listing({ place: () => ({ id: "p1" }) }));
  s.script.push(calls(callTool("layout__place", { at: "home" }, "c1")), say("Placed."));
  await s.turn("Place it.");
  const work = async (args: Record<string, unknown> = {}) =>
    JSON.parse(
      (
        (await s.actor.call("tools", "call", { name: "work", arguments: args })) as {
          output: string;
        }
      ).output,
    );
  const { works } = await work();
  assert.equal(works.length, 1);
  assert.equal(works[0].state, "idle");
  assert.deepEqual(works[0].entries[0].call, {
    name: "layout__place",
    state: "done",
    input: '{"at":"home"}',
    output: '{"id":"p1"}',
  });
  // Its capability said each change to the view of it.
  assert.ok(
    s.actor.emitted.some(
      (e) =>
        e.export === "capability" &&
        e.event === "changed" &&
        (e.payload as { view?: string }).view === "activity",
    ),
  );
  // Stopped, the agent's work is still there to read, and Work can be reached.
  await s.host.stop();
  assert.deepEqual(await s.actor.call("capability", "state", {}), {
    state: "connected",
    surfaces: [],
  });
  const page = await work({ work: works[0].id, limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.more, false);
  const unknown = (await s.actor.call("tools", "call", {
    name: "work",
    arguments: { work: "nothing" },
  })) as { output: string; failed?: true };
  assert.deepEqual(unknown, { output: "There is no such piece of work.", failed: true });
});

test("Work pages back through its pieces of work: `before` with no `work` gives those last active before that one", async () => {
  const s = await setup();
  for (let i = 1; i <= 8; i++) {
    s.script.push(say("Done."));
    const from = s.actor.emitted.length;
    await sendAs(s, `Task ${i}.`, `act_${i}`);
    await s.ended(from);
  }
  const answer = async (args: Record<string, unknown>) =>
    (await s.actor.call("tools", "call", { name: "work", arguments: args })) as {
      output: string;
      failed?: true;
    };
  const read = async (args: Record<string, unknown>) =>
    JSON.parse((await answer(args)).output) as {
      works: { id: string; at: string }[];
      more?: boolean;
    };
  const box = await read({});
  assert.equal(box.works.length, 6);
  assert.equal(box.more, true);
  const older = await read({ before: box.works.at(-1)?.id });
  assert.equal(older.works.length, 2);
  assert.equal(older.more, false);
  // The second page goes on from the first, in the same order.
  const all = [...box.works, ...older.works];
  assert.equal(new Set(all.map(({ id }) => id)).size, 8);
  const ats = all.map(({ at }) => at);
  assert.deepEqual(ats, [...ats].sort().reverse());
  assert.deepEqual(await answer({ before: "nothing" }), {
    output: "There is no such piece of work.",
    failed: true,
  });
});

test("Work's answer fits what another agent's loop takes whole: each text cut, then the oldest entries left out", async () => {
  const s = await setup();
  const big = "x".repeat(10_000);
  s.actor.expose("layout", tools, listing({ place: () => ({ big }) }));
  s.script.push(
    calls(...Array.from({ length: 30 }, (_, i) => callTool("layout__place", { big }, `c${i}`))),
    say("Placed."),
  );
  await s.turn("Place them.");
  // Two more pieces of work, each with a party of its own, so the answer with no arguments is over
  // too.
  for (const [i, text] of ["Place more.", "Place yet more."].entries()) {
    s.script.push(
      calls(...Array.from({ length: 3 }, (_, i) => callTool("layout__place", { big }, `d${i}`))),
      say("Placed."),
    );
    const from = s.actor.emitted.length;
    await sendAs(s, text, `act_${i}`);
    await s.ended(from);
  }
  const answer = async (args: Record<string, unknown>) =>
    ((await s.actor.call("tools", "call", { name: "work", arguments: args })) as { output: string })
      .output;
  const box = await answer({});
  assert.ok(box.length <= 28_000, `${box.length}`);
  const { works } = JSON.parse(box);
  assert.equal(works.length, 3);
  assert.ok(
    works.some((one: { more: boolean; entries: unknown[] }) => one.more && one.entries.length < 3),
  );
  assert.match(works[0].entries.at(-1).call.input, /… \(\d+ more characters\)$/);
  // The first piece of work is the least recently active: the last listed.
  const page = await answer({ work: works.at(-1).id, limit: 20 });
  assert.ok(page.length <= 28_000, `${page.length}`);
  const { entries, more } = JSON.parse(page);
  assert.ok(entries.length > 0 && entries.length < 20);
  assert.equal(more, true);
});

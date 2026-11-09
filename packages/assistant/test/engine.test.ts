import assert from "node:assert/strict";
import test from "node:test";
import { tools } from "@agentorg/interfaces";
import { defineInterface, method, NotConnected, OutcomeUnknown, Refused } from "@agentorg/sdk";
import { createTestContext } from "@agentorg/sdk/testing";
import { z } from "zod";
import { MAX_CALLS } from "../src/agent.ts";
import { INPUT_BUDGET } from "../src/history.ts";
import { MAX_INSTRUCTIONS } from "../src/settings.ts";
import { capped, MAX_OUTPUT, MAX_TOOLS, TOOLS_BUDGET } from "../src/tools.ts";
import engine, { INSTRUCTIONS } from "./engine-actor.ts";

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
const say = (content: string): Reply => ({
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

/** The assistant with an in-memory store and a scripted model. */
const OFFERED = [
  { id: "gpt-a", name: "A" },
  { id: "gpt-b", name: "B" },
];

async function setup(values = new Map<string, unknown>()) {
  const actor = createTestContext(engine, { actorId: "assistant", module: "logic" });
  await actor.start();
  const store = memory(values);
  actor.bind("store", store.handlers);
  const requests: Request[] = [];
  const cancels: string[] = [];
  const script: Step[] = [];
  const model = actor.bind("model", {
    models: () => ({ models: OFFERED }),
    respond: async (request) => {
      requests.push(request as Request);
      const next = script.shift() ?? say("ok");
      return (typeof next === "function" ? await next(request as Request) : next) as never;
    },
    cancel: ({ requestId }) => {
      cancels.push(requestId);
      return {};
    },
  });
  const statuses = (from = 0) =>
    actor.emitted
      .slice(from)
      .filter((e) => e.event === "status")
      .map((e) => e.payload as { state: string; detail?: { code: string; message: string } });
  /** Wait for the turn begun at `from` to end: its first idle or error status. */
  const ended = async (from: number) => {
    let end: ReturnType<typeof statuses>[number] | undefined;
    await until(() => {
      end = statuses(from).find((s) => s.state === "idle" || s.state === "error");
      return end !== undefined;
    }, "the turn to end");
    return end as NonNullable<typeof end>;
  };
  const turn = async (text: string) => {
    const from = actor.emitted.length;
    await actor.call("chat", "send", { text });
    return ended(from);
  };
  /** The messages as a view shows them: one row per id, the latest event for it. */
  const messages = () => {
    const rows = new Map<string, string>();
    for (const e of actor.emitted.filter((e) => e.event === "message")) {
      const { id, role, text } = e.payload as { id: string; role: string; text: string };
      rows.set(id, `${role}: ${text}`);
    }
    return [...rows.values()];
  };
  return { actor, store, requests, cancels, script, model, turn, ended, statuses, messages };
}

test("a tool message says its call running, then how it ended, under one id; the record keeps it", async () => {
  const s = await setup();
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
    calls(...Array.from({ length: MAX_CALLS + 1 }, (_, i) => callTool("layout__get", {}, `g${i}`))),
  );
  await s.turn("Place it, then remove p9.");
  type Shown = { id: string; role: string; text: string; tool?: Record<string, unknown> };
  const shown = s.actor.emitted
    .filter((e) => e.event === "message")
    .map((e) => e.payload as Shown)
    .filter((m) => m.role === "tool");
  const [placing, placed, removing, removed] = shown;
  assert.deepEqual(placing?.tool, {
    name: "layout__place",
    state: "running",
    input: JSON.stringify({ actor: "board", module: "panel" }),
  });
  assert.equal(placed?.id, placing?.id);
  assert.deepEqual(placed?.tool, {
    name: "layout__place",
    state: "done",
    input: JSON.stringify({ actor: "board", module: "panel" }),
    output: JSON.stringify({ id: "p1" }),
  });
  assert.equal(removed?.id, removing?.id);
  assert.notEqual(removed?.id, placed?.id);
  assert.equal(removed?.tool?.state, "refused");
  assert.match(String(removed?.tool?.output), /No such placement/);
  // Calls that never ran (past the turn's limit) are one note, with no tool.
  const note = shown.at(-1);
  assert.equal(note?.text, "3 calls: limit");
  assert.equal(note?.tool, undefined);
  // The record shows the same as the events' last word on each.
  type Page = { messages: Shown[]; more: boolean };
  const page = (before?: string) =>
    s.actor.call("chat", "history", { limit: 200, ...(before ? { before } : {}) }) as Promise<Page>;
  let { messages, more } = await page();
  while (more) {
    const older = await page(messages[0]?.id);
    messages = [...older.messages, ...messages];
    more = older.more;
  }
  const recorded = messages.filter((m) => m.role === "tool");
  assert.deepEqual(recorded[0], placed);
  assert.deepEqual(recorded[1], removed);
  assert.equal(recorded.at(-1)?.tool, undefined);
});

test("how each call ended outlives a restart, and a call ends shown even if its record fails", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  s.actor.expose(
    "layout",
    tools,
    listing({
      place: () => ({ id: "p1" }),
      // The store goes while this call runs: its record can't be written.
      remove: () => {
        s.actor.unbind("store");
        return {};
      },
    }),
  );
  s.script.push(calls(callTool("layout__place", { actor: "board", module: "panel" }, "c1")));
  await s.turn("Place it.");
  type Shown = { id: string; role: string; tool?: { state: string } };
  const again = await setup(values);
  const { messages } = (await again.actor.call("chat", "history", {})) as { messages: Shown[] };
  assert.equal(messages.find((m) => m.role === "tool")?.tool?.state, "done");

  s.script.push(calls(callTool("layout__remove", { id: "p1" }, "c2")));
  await s.turn("Remove it.");
  const last = new Map<string, Shown>();
  for (const e of s.actor.emitted.filter((e) => e.event === "message")) {
    const m = e.payload as Shown;
    last.set(m.id, m);
  }
  const states = [...last.values()].filter((m) => m.role === "tool").map((m) => m.tool?.state);
  assert.deepEqual(states, ["done", "done"]);
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
  const end = await s.turn("hello");
  assert.equal(end.state, "error");
  assert.equal(end.detail?.code, "not_connected");
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
  assert.deepEqual(await s.actor.call("chat", "models", {}), { models: offered });
  await s.turn("With the default.");
  assert.equal(s.requests.at(-1)?.model, undefined);

  await s.actor.call("chat", "setModel", { model: "gpt-b" });
  assert.deepEqual(await s.actor.call("chat", "models", {}), { models: offered, current: "gpt-b" });
  await s.turn("With the choice.");
  assert.equal(s.requests.at(-1)?.model, "gpt-b");
  await assert.rejects(s.actor.call("chat", "setModel", { model: "gpt-z" }), { code: "unknown" });

  // Kept with the agent, across a restart of its process.
  const again = await setup(values);
  assert.deepEqual(await again.actor.call("chat", "models", {}), {
    models: offered,
    current: "gpt-b",
  });
  await again.actor.call("chat", "setModel", {});
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
  assert.deepEqual(await s.turn("Show me the board."), { state: "idle" });
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
  assert.deepEqual(s.messages(), [
    "user: Show me the board.",
    "assistant: Placing it.",
    "tool: layout__place: done",
    "tool: layout__place: invalid",
    "tool: actors__list: unknown_tool",
    "tool: layout__get: invalid",
    "tool: layout__get: outcome_unknown",
    "tool: layout__remove: not_connected",
    "assistant: Placed the board.",
  ]);
  // Every call in the history has its output, right after it, as the Responses API needs.
  for (const [i, item] of last.entries())
    if (item.type === "function_call") assert.equal(last[i + 1]?.callId, item.callId);
});

test("a turn makes at most MAX_CALLS tool calls, and says so as its error", async () => {
  const s = await setup();
  let runs = 0;
  s.actor.expose(
    "layout",
    tools,
    listing({
      get: () => {
        runs++;
        return { home: [] };
      },
    }),
  );
  for (let i = 0; i < MAX_CALLS + 10; i++) s.script.push(calls(callTool("layout__get", {})));
  const from = s.actor.emitted.length;
  assert.equal((await s.turn("Loop.")).detail?.code, "limit");
  assert.equal(runs, MAX_CALLS);
  assert.equal(s.requests.length, MAX_CALLS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.statuses(from).at(-1)?.state, "error", "no idle after the limit");
  // Many calls in one reply: those past the limit are answered "limit", so every call is paired.
  s.script.length = 0;
  s.script.push(
    calls(...Array.from({ length: MAX_CALLS + 5 }, (_, i) => callTool("layout__get", {}, `m${i}`))),
  );
  runs = 0;
  assert.equal((await s.turn("Many.")).detail?.code, "limit");
  assert.equal(runs, MAX_CALLS);
  assert.equal(s.messages().filter((m) => m === "tool: 5 calls: limit").length, 1);
});

test("cancel stops the model's response, and the next turn can start at once", async () => {
  const s = await setup();
  const late = gate();
  // As the model Actor does, the cancelled response is refused `cancelled`.
  s.script.push(() =>
    late.shut.then(() => {
      throw new Refused("cancelled", "The response was cancelled.");
    }),
  );
  const from = s.actor.emitted.length;
  await s.actor.call("chat", "send", { text: "Think long." });
  await until(() => s.requests.length === 1, "the model request");
  await s.actor.call("chat", "cancel", {});
  assert.deepEqual(s.cancels, [s.requests[0]?.requestId]);
  assert.deepEqual(s.statuses(from).at(-1), { state: "idle" });
  // Not busy: a new turn starts while the old reply is still out.
  await s.turn("Next.");
  late.open();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.messages(), ["user: Think long.", "user: Next.", "assistant: ok"]);
  // A cancel isn't a failure.
  assert.equal(s.actor.logs.filter((line) => line.message === "A turn failed.").length, 0);
});

test("a cancel before the model is asked means it is never asked", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  const saved = gate();
  const store = memory(values);
  s.actor.bind("store", {
    ...store.handlers,
    set: async (input) => {
      await saved.shut;
      return store.handlers.set(input);
    },
  });
  const sending = s.actor.call("chat", "send", { text: "Never mind." });
  await new Promise((resolve) => setImmediate(resolve));
  await s.actor.call("chat", "cancel", {});
  saved.open();
  await sending;
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.requests.length, 0);
});

test("cancel during a tool call keeps its real result and skips the calls after it", async () => {
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
  await s.actor.call("chat", "send", { text: "Place it twice." });
  await running.shut;
  await s.actor.call("chat", "cancel", {});
  assert.deepEqual(s.statuses(from).at(-1), { state: "idle" });
  release.open();
  await until(() => s.messages().length === 3, "both calls recorded");
  assert.equal(entered, 1);
  assert.deepEqual(s.messages().slice(1), [
    "tool: layout__place: done",
    "tool: layout__place: cancelled",
  ]);
  assert.equal(s.requests.length, 1, "no model call after the cancel");
  // The next turn starts clean, with every call answered.
  await s.turn("Next.");
  const input = s.requests.at(-1)?.input ?? [];
  for (const [i, item] of input.entries())
    if (item.type === "function_call") assert.equal(input[i + 1]?.callId, item.callId);
});

test("one turn at a time", async () => {
  const s = await setup();
  const late = gate<Reply>();
  s.script.push(() => late.shut);
  const from = s.actor.emitted.length;
  await s.actor.call("chat", "send", { text: "First." });
  await assert.rejects(s.actor.call("chat", "send", { text: "Second." }), { code: "busy" });
  late.open(say("Done."));
  await s.ended(from);
  await s.turn("Third.");
});

test("streamed text reaches the chat as the reply it becomes", async () => {
  const s = await setup();
  s.script.push((request) => {
    s.model.emit("delta", { requestId: "someone-else", text: "not ours" });
    s.model.emit("delta", { requestId: request.requestId, text: "Hel" });
    s.model.emit("delta", { requestId: request.requestId, text: "lo." });
    return say("Hello.");
  });
  await s.turn("Hi.");
  const deltas = s.actor.emitted.filter((e) => e.event === "delta").map((e) => e.payload);
  const reply = s.actor.emitted
    .filter((e) => e.event === "message")
    .map((e) => e.payload as { id: string; role: string })
    .find((m) => m.role === "assistant");
  // The reply's chat id is its own, not the model request's.
  assert.notEqual(reply?.id, s.requests[0]?.requestId);
  assert.deepEqual(deltas, [
    { id: reply?.id, text: "Hel" },
    { id: reply?.id, text: "lo." },
  ]);
  // The next user message has a number of its own, never the reply's id.
  const next = (await s.actor.call("chat", "send", { text: "Again." })) as { messageId: string };
  assert.notEqual(next.messageId, reply?.id);
});

test("a refusal from the model ends the turn with its code, and no idle after", async () => {
  const s = await setup();
  for (const code of ["usage_limit", "not_signed_in", "unavailable", "ineligible"]) {
    s.script.push(() => {
      throw new Refused(code, `refused: ${code}`);
    });
    const from = s.actor.emitted.length;
    const status = await s.turn("Try.");
    assert.deepEqual(status, { state: "error", detail: { code, message: `refused: ${code}` } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.statuses(from).at(-1)?.state, "error");
  }
  s.actor.unbind("model");
  assert.deepEqual((await s.turn("Anyone?")).detail, {
    code: "not_connected",
    message: "model is not connected.",
  });
  assert.ok(s.actor.logs.some((line) => line.message === "A turn failed."));
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
  assert.deepEqual(await s.turn("Big."), { state: "idle" });
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
  const page = (await s.actor.call("chat", "history", {})) as { messages: unknown[] };
  assert.ok(page.messages.length > 0);
});

test("history pages back, survives a restart, and skips what doesn't read back", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  for (let i = 1; i <= 5; i++) await s.turn(`Message ${i}.`);
  const page = (await s.actor.call("chat", "history", { limit: 4 })) as {
    messages: { id: string; text: string }[];
    more: boolean;
  };
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["Message 4.", "ok", "Message 5.", "ok"],
  );
  assert.equal(page.more, true);
  const older = (await s.actor.call("chat", "history", {
    before: page.messages[0]?.id,
    limit: 100,
  })) as {
    messages: unknown[];
    more: boolean;
  };
  assert.equal(older.messages.length, 6);
  assert.equal(older.more, false);
  assert.deepEqual(await s.actor.call("chat", "history", { before: "nothing-like-it" }), {
    messages: [],
    more: false,
  });

  // Another process, the same store, one record broken: it is left out, and nothing is overwritten.
  const keys = [...values.keys()].sort();
  values.set(keys[1] as string, { not: "an entry" });
  const restarted = await setup(values);
  const all = (await restarted.actor.call("chat", "history", { limit: 200 })) as {
    messages: unknown[];
  };
  assert.equal(all.messages.length, 9);
  await restarted.turn("After.");
  assert.equal(values.size, 12);
  assert.ok(restarted.actor.logs.some((line) => line.level === "warn"));
});

test("the model gets the newest whole exchanges that fit, and a call keeps its output", async () => {
  const s = await setup();
  s.actor.expose("layout", tools, listing({ get: () => ({ home: [] }) }));
  s.script.push(calls(callTool("layout__get", {}, "first")));
  await s.turn("Message 1.");
  const bigs = Array.from({ length: 5 }, (_, i) => `${i}${"x".repeat(95_000)}`);
  for (const big of bigs) await s.turn(big);
  await s.turn("Small.");
  const sent = s.requests.at(-1)?.input ?? [];
  const texts = sent.map((item) => item.content as string);
  assert.equal(texts.includes("Message 1."), false);
  assert.equal(
    sent.some((item) => item.callId === "first"),
    false,
    "the call left with its exchange",
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

test("a cancelled turn's running call is recorded before the next message", async () => {
  const s = await setup();
  const release = gate();
  let entered = false;
  s.actor.expose(
    "layout",
    tools,
    listing({
      get: async () => {
        entered = true;
        await release.shut;
        return { home: [] };
      },
    }),
  );
  s.script.push(calls(callTool("layout__get", {}, "c1"), callTool("layout__get", {}, "c2")));
  await s.actor.call("chat", "send", { text: "One." });
  await until(() => entered, "the call to start");
  await s.actor.call("chat", "cancel", {});
  const sending = s.actor.call("chat", "send", { text: "Two." });
  release.open();
  await sending;
  await until(() => s.messages().includes("assistant: ok"), "the second turn");
  assert.deepEqual(s.messages(), [
    "user: One.",
    "tool: layout__get: done",
    "tool: layout__get: cancelled",
    "user: Two.",
    "assistant: ok",
  ]);
  assert.equal(s.actor.logs.filter((line) => line.message === "A turn failed.").length, 0);
});

test("thousands of calls in one reply cost a handful of writes", async () => {
  const s = await setup();
  s.actor.expose("layout", tools, listing({ get: () => ({ home: [] }) }));
  s.script.push(
    calls(...Array.from({ length: 2000 }, (_, i) => callTool("layout__get", {}, `x${i}`))),
  );
  const before = s.store.writes.count;
  assert.equal((await s.turn("Flood.")).detail?.code, "limit");
  // The message, `MAX_CALLS` calls, and one entry answering the other 1,980.
  assert.equal(s.store.writes.count - before, MAX_CALLS + 2);
  const input = (await s.actor.call("chat", "history", { limit: 200 })) as { messages: unknown[] };
  assert.equal(input.messages.length, 200, "a full page of what was recorded");
});

test("a long message is stored once, under storage's value limit, and a big call is still kept", async () => {
  const s = await setup();
  s.actor.expose("layout", tools, listing({ get: () => ({ home: [] }) }));
  // 45,000 CJK characters are 135 KB of UTF-8: stored twice, they would pass 256 KiB.
  assert.deepEqual(await s.turn("漢".repeat(45_000)), { state: "idle" });
  const big = { pad: "x".repeat(190_000) };
  s.script.push(calls(callTool("layout__get", big, "big")), say("done"));
  assert.deepEqual(await s.turn("Big arguments."), { state: "idle" });
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

test("state says what the agent is doing, for a view that opens late", async () => {
  const s = await setup();
  assert.deepEqual(await s.actor.call("chat", "state", {}), { state: "idle" });
  const late = gate<Reply>();
  s.script.push(() => late.shut);
  const from = s.actor.emitted.length;
  await s.actor.call("chat", "send", { text: "Think." });
  await until(() => s.requests.length === 1, "the model request");
  assert.deepEqual(await s.actor.call("chat", "state", {}), { state: "thinking" });
  late.open(say("Done."));
  await s.ended(from);
  assert.deepEqual(await s.actor.call("chat", "state", {}), { state: "idle" });
  s.script.push(() => {
    throw new Refused("usage_limit", "Usage limit reached.");
  });
  await s.turn("Again.");
  assert.deepEqual(await s.actor.call("chat", "state", {}), {
    state: "error",
    detail: { code: "usage_limit", message: "Usage limit reached." },
  });
});

test("retry runs the last turn again without recording the message twice", async () => {
  const s = await setup();
  await assert.rejects(s.actor.call("chat", "retry", {}), { code: "nothing_to_retry" });
  s.script.push(() => {
    throw new Refused("unavailable", "Try again later.");
  });
  const first = (await s.actor.call("chat", "send", { text: "Hello." })) as { messageId: string };
  await s.ended(0);
  const from = s.actor.emitted.length;
  const again = (await s.actor.call("chat", "retry", {})) as { messageId: string };
  assert.equal(again.messageId, first.messageId);
  assert.deepEqual(await s.ended(from), { state: "idle" });
  const input = s.requests.at(-1)?.input ?? [];
  assert.equal(input.filter((item) => item.content === "Hello.").length, 1);
  assert.deepEqual(s.messages(), ["user: Hello.", "assistant: ok"]);
  // Not during a turn.
  const late = gate<Reply>();
  s.script.push(() => late.shut);
  await s.actor.call("chat", "retry", {});
  await assert.rejects(s.actor.call("chat", "retry", {}), { code: "busy" });
  late.open(say("Done."));
});

test("retry replaces what followed the person's message, in the record and the model's input", async () => {
  const s = await setup();
  s.script.push(() => say("The first answer."));
  await s.actor.call("chat", "send", { text: "Hello." });
  await s.ended(0);
  assert.deepEqual(s.messages(), ["user: Hello.", "assistant: The first answer."]);
  const from = s.actor.emitted.length;
  s.script.push(() => say("The second answer."));
  await s.actor.call("chat", "retry", {});
  await s.ended(from);
  // The model isn't sent the reply it is being asked to replace.
  const input = s.requests.at(-1)?.input ?? [];
  assert.equal(input.filter((item) => item.content === "The first answer.").length, 0);
  assert.equal(input.filter((item) => item.content === "Hello.").length, 1);
  const { messages } = (await s.actor.call("chat", "history", {})) as {
    messages: { role: string; text: string }[];
  };
  assert.deepEqual(
    messages.map((m) => `${m.role}: ${m.text}`),
    ["user: Hello.", "assistant: The second answer."],
  );
});

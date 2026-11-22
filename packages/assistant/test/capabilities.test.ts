import assert from "node:assert/strict";
import test from "node:test";
import { chat, tools } from "@agentorg/interfaces";
import { describeInterface, NotConnected, Refused } from "@agentorg/sdk";
import type { Context } from "cordis";
import { connections } from "../src/capabilities/connections.ts";
import { instructions } from "../src/capabilities/instructions.ts";
import { skills } from "../src/capabilities/skills.ts";
import type { AgentHub } from "../src/connector.ts";
import { type Capability, createPluginHost, type Request } from "../src/plugins.ts";

/** A kv store in memory, as an agent's own store answers. */
function memory() {
  const values = new Map<string, unknown>();
  return {
    get: async ({ key }: { key: string }) =>
      values.has(key) ? { value: values.get(key) as never } : {},
    set: async ({ key, value }: { key: string; value: unknown }) => {
      values.set(key, value);
      return {};
    },
    delete: async ({ key }: { key: string }) => ({ deleted: values.delete(key) }),
    list: async ({ prefix = "" }: { prefix?: string }) => ({
      keys: [...values.keys()].filter((key) => key.startsWith(prefix)).sort(),
      next: null,
    }),
  };
}
const fresh = (): Request => ({ instructions: [], functions: [], input: [], leftOut: [] });
const warnings: string[] = [];
const log = { info() {}, warn: (line: string) => void warnings.push(line), error() {} };

/** A capability whose pass adds a part named for it, at `order`. */
const naming = (name: string, order?: number): Capability => ({
  name,
  inject: ["context"],
  apply(ctx: Context) {
    ctx.context.pass(
      (request) => void request.instructions.push({ owner: name, text: name }),
      order === undefined ? {} : { order },
    );
  },
});
const owners = (request: Request) => request.instructions.map(({ owner }) => owner);

test("passes run by their order, then in the order the agent's settings name their capabilities; one loaded again with other settings keeps its place", async () => {
  const plugins = await createPluginHost(log, [naming("a"), naming("b"), naming("c", -5)]).open(
    "agent",
    { store: memory() },
  );
  await plugins.hold([{ name: "a", settings: { v: 1 } }, { name: "b" }, { name: "c" }]);
  assert.deepEqual(owners(plugins.pass(fresh())), ["c", "a", "b"]);
  await plugins.hold([{ name: "a", settings: { v: 2 } }, { name: "b" }, { name: "c" }]);
  assert.deepEqual(owners(plugins.pass(fresh())), ["c", "a", "b"]);
  // Named in another order, they pass in it.
  await plugins.hold([{ name: "b" }, { name: "a", settings: { v: 2 } }, { name: "c" }]);
  assert.deepEqual(owners(plugins.pass(fresh())), ["c", "b", "a"]);
  await plugins.close();
});

test("what a capability reads once a turn is read before the turn's requests, one after another in their order; one that fails is logged, and the turn goes on", async () => {
  const read: string[] = [];
  const reading = (name: string, fails = false): Capability => ({
    name,
    inject: ["context"],
    apply(ctx: Context) {
      let turns = 0;
      ctx.context.turn(async (loop) => {
        await new Promise((done) => setTimeout(done, name === "first" ? 10 : 0));
        read.push(`${name}:${loop?.id ?? "none"}`);
        if (fails) throw new Error("No.");
        turns++;
      });
      ctx.context.pass(
        (request) => void request.instructions.push({ owner: name, text: `${turns}` }),
      );
    },
  });
  const plugins = await createPluginHost(log, [
    reading("first"),
    reading("failing", true),
    reading("second"),
  ]).open("agent", { store: memory() });
  await plugins.hold([{ name: "first" }, { name: "failing" }, { name: "second" }]);
  warnings.length = 0;
  await plugins.turn({ id: "c1", with: "person" });
  assert.deepEqual(read, ["first:c1", "failing:c1", "second:c1"]);
  assert.deepEqual(warnings, [
    "A capability couldn't read what its passes give; the turn goes on.",
  ]);
  // Read once a turn, however many requests pass.
  plugins.pass(fresh());
  const passed = plugins.pass(fresh());
  assert.deepEqual(
    passed.instructions.map(({ owner, text }) => `${owner}:${text}`),
    ["first:1", "failing:0", "second:1"],
  );
  await plugins.close();
});

/** A stand-in for the agent's channel: `exposed` is what is exposed to it, `skill` reads a skill's file. */
function hubOf(exposed: object[], skill?: (input: { name: string; path?: string }) => unknown) {
  return {
    exposed: () => exposed,
    onExposed: () => () => {},
    slots: { settings: { call: { skill: async (input: never) => skill?.(input) } } },
  } as unknown as AgentHub;
}
const connector = (hub: AgentHub): Capability => ({
  name: "connector",
  inject: [],
  provide: "hub",
  apply: (ctx: Context) => void ctx.provide("hub", hub),
});
const toolsSlot = (slot: string, list: () => Promise<unknown>) => ({
  slot,
  described: describeInterface(tools),
  provider: { actor: `act_${slot}`, export: "tools" },
  call: { list, call: async () => ({ output: "done" }) },
  on: () => () => {},
});

test("connections lists every exposed tools@1 slot once a turn, offers the agents it talks to before other capabilities' functions and its slots after them, and says a slot that can't answer", async () => {
  let listed = 0;
  const hub = hubOf([
    toolsSlot("files", async () => {
      listed++;
      return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
    }),
    toolsSlot("away", async () => {
      throw new NotConnected("away");
    }),
    {
      slot: "chat_act_kid",
      described: describeInterface(chat),
      provider: { actor: "act_kid", export: "chat" },
      call: {},
      on: () => () => {},
    },
  ]);
  const notes: Capability = {
    name: "notes",
    inject: ["tools"],
    apply(ctx: Context) {
      ctx.tools.register({
        name: "keep",
        parameters: { type: "object" },
        run: async () => ({ output: "kept", ok: true }),
      });
    },
  };
  const plugins = await createPluginHost(log, [notes]).open("agent", {
    store: memory(),
    provides: ["hub"],
  });
  await plugins.mount(connector(hub));
  await plugins.mount(connections());
  await plugins.hold([{ name: "notes" }]);
  await plugins.turn();
  plugins.pass(fresh());
  const passed = plugins.pass(fresh());
  assert.equal(listed, 1);
  assert.deepEqual(
    passed.functions.map(({ slot, name }) => `${slot}__${name}`),
    ["agents__send", "agents__read", "notes__keep", "files__read"],
  );
  assert.deepEqual(passed.leftOut, [{ slot: "away", reason: "not_connected" }]);
  await plugins.close();
});

const EARLIER = "You are an agent, as its template once said.";
const REVIEW = { name: "review", description: "Review a change." };

test("instructions and skills tell the agent's words first, then what each skill always says, read once a turn, then the skills' names, and offer the function that reads them", async () => {
  const read: string[] = [];
  const hub = hubOf([], ({ name, path }) => {
    read.push(`${name}/${path}`);
    if (name === "review") return { text: "Review only what you are shown." };
    throw new Refused("unknown", "No such file.");
  });
  const plugins = await createPluginHost(log, [
    instructions({ now: () => "You are an agent.", earlier: EARLIER }),
    skills(),
  ]).open("agent", { store: memory(), provides: ["hub"] });
  await plugins.mount(connector(hub));
  await plugins.hold([
    { name: "instructions", settings: { text: `${EARLIER}\n\nWhat you are for: docs.` } },
    {
      name: "skills",
      settings: { skills: [REVIEW, { name: "plain", description: "Says nothing always." }] },
    },
  ]);
  await plugins.turn();
  plugins.pass(fresh());
  const passed = plugins.pass(fresh());
  assert.deepEqual(read.sort(), ["plain/ALWAYS.md", "review/ALWAYS.md"]);
  // Its template's earlier words are told as its words now.
  assert.deepEqual(
    passed.instructions.map(({ owner, text }) => [owner, text]),
    [
      ["agent", "You are an agent.\n\nWhat you are for: docs."],
      ["review/ALWAYS.md", "Review only what you are shown."],
      [
        "skills",
        "## Skills\nA skill is written instructions for a kind of task. When one fits what you're asked, read it with settings__skill and follow it before you start. Pass path to read a file its SKILL.md refers to.\n- review: Review a change.\n- plain: Says nothing always.",
      ],
    ],
  );
  assert.deepEqual(
    passed.functions.map(({ slot, name }) => `${slot}__${name}`),
    ["settings__skill"],
  );
  // With no skills, nothing of them, and nothing to read them with.
  await plugins.hold([
    { name: "instructions", settings: { text: "Keep the docs." } },
    { name: "skills", settings: { skills: [] } },
  ]);
  await plugins.turn();
  const none = plugins.pass(fresh());
  assert.deepEqual(owners(none), ["agent"]);
  assert.deepEqual(none.functions, []);
  await plugins.close();
});

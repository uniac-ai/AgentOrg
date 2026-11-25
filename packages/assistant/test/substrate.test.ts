import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "cordis";
import { type Capability, createPluginHost } from "../src/plugins.ts";

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
const quiet = { info() {}, warn() {}, error() {} };
const BUNDLED = ["agent", "store", "tools", "prompt"].map((name) => ({ name, state: "mounted" }));
/** What the agent holds, by name and state, and parent where it has one. */
const held = (list: { name: string; state: string; parent?: string; detail?: string }[]) =>
  list.map(({ name, state, parent, detail }) => ({
    name,
    state,
    ...(parent ? { parent } : {}),
    ...(detail ? { detail } : {}),
  }));
const fn = (name: string) => ({
  name,
  parameters: { type: "object" },
  run: async () => ({ output: name, ok: true }),
});

declare module "cordis" {
  interface Context {
    lines: { read(): string[] };
    base: { round: number };
    weather: { now(): string };
  }
}

test("an agent is created holding the bundled capabilities on the three primitives, and lists what it holds", async () => {
  const notes: Capability = { name: "notes", title: "Notes", inject: ["tools"], apply() {} };
  const plugins = await createPluginHost(quiet, [notes]).open("a", { store: memory() });
  assert.deepEqual(held(plugins.list()), BUNDLED);
  await plugins.hold([{ name: "notes" }, { name: "absent" }]);
  assert.deepEqual(held(plugins.list()), [
    ...BUNDLED,
    { name: "notes", state: "mounted" },
    { name: "absent", state: "failed", detail: "Its executor doesn't carry it." },
  ]);
  assert.equal(plugins.list().find((one) => one.name === "notes")?.title, "Notes");
  await plugins.close();
});

test("a capability offers a service and, in the same mount, mounts a child that needs it: the child goes with it, each taken off deepest first", async () => {
  const taken: string[] = [];
  const tidy: Capability = {
    name: "tidy",
    title: "Keeps the lines tidy",
    inject: ["lines", "tools"],
    apply(ctx: Context) {
      ctx.tools.register(fn(`tidy-${ctx.lines.read().length}`));
    },
    unmount: () => void taken.push("tidy"),
  };
  const lines: Capability = {
    name: "lines",
    inject: ["capabilities"],
    provide: "lines",
    async apply(ctx: Context) {
      ctx.provide("lines", { read: () => ["one", "two"] });
      await ctx.capabilities.mount(tidy);
      // A capability is held once, by its name, wherever it was mounted.
      await assert.rejects(ctx.capabilities.mount(tidy), /holds tidy already/);
    },
    unmount: () => void taken.push("lines"),
  };
  const plugins = await createPluginHost(quiet, [lines]).open("a", { store: memory() });
  assert.deepEqual((await plugins.hold([{ name: "lines" }])).without, []);
  assert.deepEqual(held(plugins.list()), [
    ...BUNDLED,
    { name: "lines", state: "mounted" },
    { name: "tidy", state: "mounted", parent: "lines" },
  ]);
  assert.deepEqual(
    plugins.tools().map(({ slot, name }) => `${slot}__${name}`),
    ["tidy__tidy-2"],
  );
  // Taken off: the child's unmount, then its parent's, and nothing of either is left.
  await plugins.hold([]);
  assert.deepEqual(taken, ["tidy", "lines"]);
  assert.deepEqual(held(plugins.list()), BUNDLED);
  assert.deepEqual(plugins.tools(), []);
  await plugins.close();
});

test("a child that can't be mounted is said failed, with why, under its parent, which runs on", async () => {
  const broken: Capability = {
    name: "broken",
    inject: [],
    apply() {
      throw new Error("Its lines couldn't be read.");
    },
  };
  const waiting: Capability = { name: "waiting", inject: ["nowhere"], apply() {} };
  const said: string[] = [];
  const parent: Capability = {
    name: "parent",
    inject: ["capabilities"],
    async apply(ctx: Context) {
      for (const child of [broken, waiting])
        await ctx.capabilities.mount(child).catch((error: Error) => void said.push(error.message));
    },
  };
  const plugins = await createPluginHost(quiet, [parent]).open("a", { store: memory() });
  await plugins.hold([{ name: "parent" }]);
  // One that throws is said at once. One that waits for a service may be waiting for its parent's,
  // so it is judged once its parent's mount ends, and the list says it.
  assert.deepEqual(said, ["Its lines couldn't be read."]);
  assert.deepEqual(held(plugins.list()), [
    ...BUNDLED,
    { name: "parent", state: "mounted" },
    { name: "broken", state: "failed", parent: "parent", detail: "Its lines couldn't be read." },
    {
      name: "waiting",
      state: "failed",
      parent: "parent",
      detail: "It needs a service none of the agent's capabilities provides.",
    },
  ]);
  // Its parent going takes what it couldn't mount out of the list too.
  await plugins.hold([]);
  assert.deepEqual(held(plugins.list()), BUNDLED);
  await plugins.close();
});

test("each capability has a signal that ends when it is taken off or its agent closes, not when its agent stops", async () => {
  const signals = new Map<string, AbortSignal>();
  const watching = (name: string): Capability => ({
    name,
    inject: ["capabilities"],
    apply(ctx: Context) {
      signals.set(name, ctx.capabilities.signal);
    },
  });
  const host = createPluginHost(quiet, [watching("one"), watching("two")]);
  const plugins = await host.open("a", { store: memory() });
  await plugins.hold([{ name: "one" }, { name: "two" }]);
  plugins.life("stopped");
  await new Promise((done) => setImmediate(done));
  assert.equal(signals.get("one")?.aborted, false);
  await plugins.hold([{ name: "two" }]);
  assert.equal(signals.get("one")?.aborted, true);
  assert.equal(signals.get("two")?.aborted, false);
  await plugins.close();
  assert.equal(signals.get("two")?.aborted, true);
});

test("a capability says whether it can do its part now, and the list says it", async () => {
  let say: (state: "mounted" | "down", detail?: string) => void = () => {};
  const connector: Capability = {
    name: "connector",
    inject: ["capabilities"],
    apply(ctx: Context) {
      say = (state, detail) => ctx.capabilities.say(state, detail);
    },
  };
  const plugins = await createPluginHost(quiet, [connector]).open("a", { store: memory() });
  await plugins.hold([{ name: "connector" }]);
  say("down", "Its connection to the Hub ended.");
  assert.deepEqual(held(plugins.list()).at(-1), {
    name: "connector",
    state: "down",
    detail: "Its connection to the Hub ended.",
  });
  say("mounted");
  assert.deepEqual(held(plugins.list()).at(-1), { name: "connector", state: "mounted" });
  await plugins.close();
});

test("passes run in the order their capabilities were mounted, are told which loop, and may change any of the request", async () => {
  const warnings: string[] = [];
  const log = { ...quiet, warn: (line: string) => void warnings.push(line) };
  const order: string[] = [];
  const passing = (name: string): Capability => ({
    name,
    inject: ["context"],
    apply(ctx: Context) {
      ctx.context.pass((request) => {
        order.push(`${name}:${request.loop?.id ?? "none"}`);
        request.instructions.push({ owner: `plugin:${name}/note`, text: `From ${name}.` });
        request.functions.push({ slot: name, ...fn("look") });
        request.input.push({ role: "user", content: `${name} was here.` } as never);
      });
    },
  });
  // A pass that throws is logged, and the request goes on with the others' changes.
  const failing: Capability = {
    name: "failing",
    inject: ["context"],
    apply(ctx: Context) {
      ctx.context.pass(() => {
        throw new Error("no words");
      });
    },
  };
  const host = createPluginHost(log, [passing("first"), passing("second"), failing]);
  const plugins = await host.open("a", { store: memory() });
  // Named second then first: mounted in that order, and passed in it.
  await plugins.hold([{ name: "second" }, { name: "failing" }, { name: "first" }]);
  // What holding them passed is not this test's.
  order.length = 0;
  warnings.length = 0;
  const loop = { id: "person", with: "person" };
  const passed = plugins.pass({ loop, instructions: [], functions: [], input: [], leftOut: [] });
  assert.deepEqual(order, ["second:person", "first:person"]);
  assert.deepEqual(
    passed.instructions.map(({ owner }) => owner),
    ["plugin:second/note", "plugin:first/note"],
  );
  assert.deepEqual(
    passed.functions.map(({ slot }) => slot),
    ["second", "first"],
  );
  assert.deepEqual(
    passed.input.map((one) => (one as { content: string }).content),
    ["second was here.", "first was here."],
  );
  assert.deepEqual(warnings, [
    "A capability's pass failed; the request goes on without what it did.",
  ]);
  await plugins.close();
});

test("a capability applied again, as a service it needs comes back, mounts its children afresh with a signal of its own", async () => {
  const signals: AbortSignal[] = [];
  const base: Capability<{ round: number }> = {
    name: "base",
    inject: [],
    provide: "base",
    apply(ctx: Context, { round }) {
      ctx.provide("base", { round });
    },
  };
  const child: Capability = { name: "child", inject: ["lines"], apply() {} };
  const parent: Capability = {
    name: "parent",
    inject: ["capabilities", "base"],
    provide: "lines",
    async apply(ctx: Context) {
      signals.push(ctx.capabilities.signal);
      ctx.provide("lines", { read: () => [] });
      await ctx.capabilities.mount(child);
    },
  };
  const plugins = await createPluginHost(quiet, [base, parent]).open("a", { store: memory() });
  const holding = (round: number) =>
    plugins.hold([{ name: "base", settings: { round } }, { name: "parent" }]);
  assert.deepEqual((await holding(1)).without, []);
  const mounted = [
    ...BUNDLED,
    { name: "base", state: "mounted" },
    { name: "parent", state: "mounted" },
    { name: "child", state: "mounted", parent: "parent" },
  ];
  assert.deepEqual(held(plugins.list()), mounted);
  // Its base mounted again with other settings, after it: it is applied again, and so is its child.
  assert.deepEqual((await holding(2)).without, []);
  assert.deepEqual(held(plugins.list()), [
    ...BUNDLED,
    { name: "parent", state: "mounted" },
    { name: "base", state: "mounted" },
    { name: "child", state: "mounted", parent: "parent" },
  ]);
  assert.equal(signals.length, 2);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
  await plugins.close();
});

/**
 * A service no capability provides when the agent opens: `weather`, provided once this is mounted.
 * Each of `before` is mounted as its child before the service is there.
 */
const weather = (now: string, before: Capability[] = []): Capability => ({
  name: "weather",
  inject: ["capabilities"],
  provide: "weather",
  async apply(ctx: Context) {
    for (const child of before) await ctx.capabilities.mount(child);
    ctx.provide("weather", { now: () => now });
  },
});
/** One that uses `weather`, and offers a function named by what it reads. */
const reader = (name: string): Capability => ({
  name,
  inject: ["weather", "tools"],
  apply(ctx: Context) {
    ctx.tools.register(fn(`${name}-${ctx.weather.now()}`));
  },
});
/** An agent, and a hand on its capabilities, as control mounts them while the agent runs. */
async function agentWithHand(host: ReturnType<typeof createPluginHost>, agent: string) {
  const plugins = await host.open(agent, { store: memory() });
  let hand: Context | undefined;
  await plugins.mount({
    name: "hand",
    inject: ["capabilities"],
    apply(ctx: Context) {
      hand = ctx;
    },
  });
  return { plugins, capabilities: (hand as Context).capabilities };
}
const offered = (plugins: { tools(): { slot: string; name: string }[] }) =>
  plugins
    .tools()
    .map(({ slot, name }) => `${slot}__${name}`)
    .sort();

test("a service a capability provides after the agent opened is its agent's: one mounted before it, as its child, and one mounted after both use it", async () => {
  const { plugins, capabilities } = await agentWithHand(createPluginHost(quiet, []), "a");
  await capabilities.mount(weather("sun", [reader("early")]));
  await capabilities.mount(reader("late"));
  assert.deepEqual(offered(plugins), ["early__early-sun", "late__late-sun"]);
  assert.deepEqual(held(plugins.list()).slice(BUNDLED.length), [
    { name: "hand", state: "mounted" },
    { name: "weather", state: "mounted", parent: "hand" },
    { name: "early", state: "mounted", parent: "weather" },
    { name: "late", state: "mounted", parent: "hand" },
  ]);
  await plugins.close();
});

test("another agent doesn't see a service one agent's capability provided while it runs, and can have its own under the same name", async () => {
  const host = createPluginHost(quiet, []);
  const a = await agentWithHand(host, "a");
  const b = await agentWithHand(host, "b");
  await a.capabilities.mount(weather("sun"));
  await assert.rejects(b.capabilities.mount(reader("late")), /needs a service/);
  // Its own, with no clash: each agent keeps its own under its own label.
  await b.capabilities.mount(weather("rain"));
  await b.capabilities.mount(reader("late"));
  await a.capabilities.mount(reader("late"));
  assert.deepEqual(offered(a.plugins), ["late__late-sun"]);
  assert.deepEqual(offered(b.plugins), ["late__late-rain"]);
  // So is one mounted by the agent's own mount, as the executor mounts its own.
  await a.plugins.mount({
    name: "fog",
    inject: [],
    provide: "fog",
    apply(ctx: Context) {
      ctx.provide("fog" as never, {} as never);
    },
  });
  await assert.rejects(
    b.plugins.mount({ name: "fog-reader", inject: ["fog"], apply() {} }),
    /needs a service/,
  );
  // What the agent kept from the start is its own as before: each agent's functions are its own.
  await a.plugins.close();
  assert.deepEqual(offered(b.plugins), ["late__late-rain"]);
  await b.plugins.close();
});

test("a service provided while the agent runs goes when its provider is taken off: what used it goes too, and nothing new finds it", async () => {
  const { plugins, capabilities } = await agentWithHand(createPluginHost(quiet, []), "a");
  await capabilities.mount(weather("sun"));
  await capabilities.mount(reader("late"));
  assert.deepEqual(offered(plugins), ["late__late-sun"]);
  await capabilities.unmount("weather");
  assert.deepEqual(offered(plugins), []);
  assert.ok(!plugins.list().some((one) => one.name === "weather" && one.state === "mounted"));
  await assert.rejects(capabilities.mount(reader("later")), /needs a service/);
  // Provided again, a reader mounted now uses the new one.
  await capabilities.mount(weather("snow"));
  await capabilities.mount(reader("again"));
  assert.ok(offered(plugins).includes("again__again-snow"));
  await plugins.close();
});

test("no service is provided at the root, for all agents: each a capability may inject is its agent's, where its labels find it", async () => {
  // Cordis's own root provides none: its reflect, registry, events and logger are properties,
  // which no capability injects.
  assert.deepEqual(Reflect.ownKeys(new Context().reflect.store), []);
  // Nor does the executor's host, once an agent has opened and its capabilities are up.
  const plugins = await createPluginHost(quiet, []).open("a", { store: memory() });
  let seen: Context | undefined;
  await plugins.mount({
    name: "probe",
    inject: [],
    apply(ctx: Context) {
      seen = ctx;
    },
  });
  const root = (seen as Context)[Context.root];
  const { store } = root.reflect;
  const atRoot = Reflect.ownKeys(store).flatMap((label) => {
    const impl = store[label as symbol];
    return impl && root[Context.isolate][impl.name] === label ? [impl.name] : [];
  });
  assert.deepEqual(
    atRoot,
    [],
    "A service provided at the root is every agent's, and a capability injecting it looks under its agent's label: keep its name out of the agent's labels.",
  );
  // Each the agent's capabilities provide is there, under the agent's own label.
  assert.ok(Reflect.ownKeys(store).length > 0);
  await plugins.close();
});

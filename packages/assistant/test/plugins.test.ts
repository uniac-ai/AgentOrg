import assert from "node:assert/strict";
import test from "node:test";
import { type Context, Service } from "cordis";
import {
  AGENT_EVENTS,
  Agent,
  type AgentPlugin,
  createPluginHost,
  type Life,
} from "../src/plugins.ts";
import { saying } from "./saying.ts";

/** A kv store in memory, as an agent's own store answers. */
function memory() {
  const values = new Map<string, unknown>();
  return {
    values,
    store: {
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
    },
  };
}
const quiet = { info() {}, warn() {}, error() {} };
const logged = () => {
  const warnings: string[] = [];
  return { warnings, log: { ...quiet, warn: (message: string) => void warnings.push(message) } };
};
/** A plugin as a test has an agent hold it: with its settings, where it has any. */
// biome-ignore lint/suspicious/noExplicitAny: each plugin's settings are its own.
type Given = { plugin: AgentPlugin<any>; config?: Record<string, unknown> };
/** Each by its name, with its settings, as an agent's settings name them. */
const named = (given: Given[]) =>
  given.map(({ plugin, config }) => ({
    name: plugin.name,
    ...(config ? { settings: config } : {}),
  }));
/** A host that carries these. */
const carrying = (given: Given[], log: Parameters<typeof createPluginHost>[0] = quiet) =>
  createPluginHost(
    log,
    given.map(({ plugin }) => plugin),
  );
/** `agent` holding these, in `host`, or in a host that carries just them. */
const holding = async (
  agent: string,
  store: ReturnType<typeof memory>["store"],
  given: Given[],
  host = carrying(given),
) => {
  const plugins = await host.open(agent, { store });
  await plugins.hold(named(given));
  return plugins;
};

/**
 * A plugin that gives a function and a section, keeps what it is told, and writes what it hears:
 * it names the four services it uses.
 */
const notes: AgentPlugin<{ greeting: string }> = {
  name: "notes",
  inject: ["tools", "prompt", "store", "agent"],
  apply(ctx: Context, { greeting }) {
    let count = 0;
    ctx.tools.register({
      name: "keep",
      description: "Keeps a note.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      async run(input) {
        count += 1;
        await ctx.store.set({ key: "last", value: (input as { text: string }).text });
        return { output: "Kept.", ok: true } as never;
      },
    });
    ctx.prompt.section({
      name: "count",
      text: () => `${greeting} ${ctx.agent.id}: ${count} kept.`,
    });
    for (const [life, event] of Object.entries(AGENT_EVENTS) as [Life, string][])
      ctx.on(event as "agent/idle", ({ work }) =>
        ctx.store.set({ key: `heard/${life}`, value: work ?? null }),
      );
  },
};

test("an agent with no plugins is given nothing and hears nothing: its requests are as they were", async () => {
  const { store } = memory();
  const plugins = await createPluginHost(quiet).open("a", { store });
  assert.deepEqual(plugins.tools(), []);
  assert.deepEqual(plugins.blocks(), []);
  await plugins.close();
});

test("a plugin gives its agent a function under its own name, a block read afresh, a store of its own, and hears its life", async () => {
  const { store, values } = memory();
  const plugins = await holding("a", store, [{ plugin: notes, config: { greeting: "Hello" } }]);
  const [tool] = plugins.tools();
  assert.equal(tool?.slot, "notes");
  assert.equal(tool?.name, "keep");
  assert.deepEqual(plugins.blocks(), [{ owner: "plugin:notes/count", text: "Hello a: 0 kept." }]);
  await tool?.run({ text: "Buy milk." }, "g1");
  // The section is read for each request: it says what changed since.
  assert.deepEqual(plugins.blocks(), [{ owner: "plugin:notes/count", text: "Hello a: 1 kept." }]);
  // Its store is its own, under the agent's.
  assert.equal(values.get("plugin/notes/last"), "Buy milk.");
  plugins.life("turnStarted", { work: "w1" });
  plugins.life("idle");
  await new Promise((done) => setImmediate(done));
  assert.equal(values.get("plugin/notes/heard/turnStarted"), "w1");
  assert.equal(values.get("plugin/notes/heard/idle"), null);
  // Unloading it leaves what it stored: adding it again finds it.
  await plugins.close();
  const again = await holding("a", store, [{ plugin: notes, config: { greeting: "Hello" } }]);
  assert.equal(values.get("plugin/notes/last"), "Buy milk.");
  await again.close();
});

test("a plugin's own components, and a service it provides, use the agent's services as that plugin", async () => {
  const { store, values } = memory();
  /** A service one plugin provides, written as Cordis services are: it reaches the others by `this.ctx`. */
  class Keeping extends Service {
    constructor(ctx: Context) {
      super(ctx, "keeping");
    }
    keep(text: string) {
      this.ctx.store.set({ key: "kept", value: text });
      this.ctx.tools.register({
        name: "recall",
        parameters: { type: "object" },
        run: async () => ({ output: text, ok: true }) as never,
      });
    }
  }
  const keeper: AgentPlugin = {
    name: "keeper",
    inject: ["store", "tools"],
    provide: "keeping",
    async apply(ctx: Context) {
      await ctx.use(Keeping);
      // A component of its own uses the store as it.
      await ctx.use({
        name: "inner",
        inject: ["store"],
        apply: (inner: Context) => void inner.store.set({ key: "inner", value: true }),
      });
    },
  };
  const user: AgentPlugin = {
    name: "user",
    inject: ["keeping"],
    apply: (ctx: Context) => (ctx as Context & { keeping: Keeping }).keeping.keep("Sam"),
  };
  const plugins = await holding("a", store, [{ plugin: keeper }, { plugin: user }]);
  await new Promise((done) => setImmediate(done));
  // The service is the plugin that provides it, whoever calls it.
  assert.equal(values.get("plugin/keeper/kept"), "Sam");
  assert.equal(values.get("plugin/keeper/inner"), true);
  assert.deepEqual(
    [...values.keys()].filter((key) => key.startsWith("plugin/user/")),
    [],
  );
  assert.deepEqual(
    plugins.tools().map(({ slot, name }) => `${slot}__${name}`),
    ["keeper__recall"],
  );
  await plugins.close();
});

test("sections come in their order, then by plugin and name, the same at every start; a plugin names each once", async () => {
  const section = (name: string, sections: { name: string; order?: number }[]): AgentPlugin => ({
    name,
    inject: ["prompt"],
    apply(ctx: Context) {
      for (const one of sections) ctx.prompt.section({ ...one, text: () => one.name });
    },
  });
  const plugins = await holding("a", memory().store, [
    {
      plugin: section("zeta", [
        { name: "first", order: -1 },
        { name: "last", order: 5 },
      ]),
    },
    { plugin: section("alpha", [{ name: "b" }, { name: "a" }]) },
  ]);
  assert.deepEqual(
    plugins.blocks().map(({ owner }) => owner),
    ["plugin:zeta/first", "plugin:alpha/a", "plugin:alpha/b", "plugin:zeta/last"],
  );
  await plugins.close();
  await assert.rejects(
    holding("a", memory().store, [
      { plugin: section("twice", [{ name: "same" }, { name: "same" }]) },
    ]),
    /The plugin twice has a section named same already\./,
  );
});

test("each agent's plugins are its own: one agent's give another nothing and hear nothing of it, and closing one leaves the other", async () => {
  const host = createPluginHost(quiet, [notes]);
  const [ofA, ofB] = [memory(), memory()];
  const a = await holding("a", ofA.store, [{ plugin: notes, config: { greeting: "Hi" } }], host);
  const b = await holding("b", ofB.store, [{ plugin: notes, config: { greeting: "Yo" } }], host);
  assert.deepEqual(
    a.blocks().map(({ text }) => text),
    ["Hi a: 0 kept."],
  );
  assert.deepEqual(
    b.blocks().map(({ text }) => text),
    ["Yo b: 0 kept."],
  );
  // An agent's life is told to its own plugins only.
  a.life("idle");
  await new Promise((done) => setImmediate(done));
  assert.equal(ofA.values.get("plugin/notes/heard/idle"), null);
  assert.equal(ofB.values.has("plugin/notes/heard/idle"), false);
  await a.close();
  // What it registered goes with it.
  assert.deepEqual(a.tools(), []);
  assert.deepEqual(a.blocks(), []);
  assert.equal(b.tools().length, 1);
  assert.deepEqual(
    b.blocks().map(({ text }) => text),
    ["Yo b: 0 kept."],
  );
  await b.close();
});

declare module "cordis" {
  interface Context {
    tally: { count: number; add(): void };
    naming: { name: string };
  }
}

/** A plugin that provides a service to its agent's other plugins: a tally they share. */
const tally: AgentPlugin = {
  name: "tally",
  inject: ["agent"],
  provide: "tally",
  apply(ctx: Context) {
    const own = {
      count: 0,
      add() {
        own.count += 1;
      },
    };
    ctx.provide("tally", own);
  },
};
/** A second service, from another plugin: the name the tally is said under. */
const naming: AgentPlugin = {
  name: "naming",
  inject: ["agent"],
  provide: "naming",
  apply(ctx: Context) {
    ctx.provide("naming", { name: ctx.agent.id });
  },
};
/** A plugin that uses both services its agent's other plugins provide, and says them in a block. */
const counting: AgentPlugin = {
  name: "counting",
  inject: ["tools", "prompt", "tally", "naming"],
  apply(ctx: Context) {
    ctx.tools.register({
      name: "count",
      parameters: { type: "object", properties: {} },
      async run() {
        ctx.tally.add();
        return { output: "Counted.", ok: true } as never;
      },
    });
    ctx.prompt.section({
      name: "count",
      text: () => `${ctx.naming.name} counted ${ctx.tally.count}.`,
    });
  },
};

test("a service one plugin provides is its agent's alone: two agents holding the same plugins each have their own, and it goes with its agent", async () => {
  // Two services, used by a plugin listed before the plugins that provide them.
  const held = [{ plugin: counting }, { plugin: tally }, { plugin: naming }];
  const host = carrying(held);
  const a = await holding("a", memory().store, held, host);
  const b = await holding("b", memory().store, held, host);
  // The plugin that uses it is loaded in each, with the service its own agent's plugin provides.
  assert.deepEqual(
    [...a.blocks(), ...b.blocks()].map(({ text }) => text),
    ["a counted 0.", "b counted 0."],
  );
  const [count] = a.tools();
  await count?.run({}, "g1");
  await count?.run({}, "g2");
  assert.deepEqual(
    a.blocks().map(({ text }) => text),
    ["a counted 2."],
  );
  assert.deepEqual(
    b.blocks().map(({ text }) => text),
    ["b counted 0."],
  );
  await a.close();
  // The other agent's is still there and still its own.
  await b.tools()[0]?.run({}, "g3");
  assert.deepEqual(
    b.blocks().map(({ text }) => text),
    ["b counted 1."],
  );
  // A third agent holding them later starts afresh.
  const c = await holding("c", memory().store, held, host);
  assert.deepEqual(
    c.blocks().map(({ text }) => text),
    ["c counted 0."],
  );
  await b.close();
  await c.close();
});

test("a plugin that needs a service none of the agent's plugins provides can't be held, and leaves nothing loaded", async () => {
  const all = [{ plugin: tally }, { plugin: naming }, { plugin: counting }];
  const again = await carrying(all).open("a", { store: memory().store });
  await assert.rejects(
    again.hold(named([{ plugin: tally }, { plugin: counting }])),
    /counting needs a service none of the agent's plugins provides/,
  );
  assert.deepEqual(again.blocks(), []);
  // What it loaded is gone: the same plugins load once the one that provides the service is named.
  await again.hold(named(all));
  assert.deepEqual(
    again.blocks().map(({ text }) => text),
    ["a counted 0."],
  );
  await again.close();
});

test("a plugin's failures are logged, never the agent's: a section that throws is left out, a listener that throws doesn't stop the others", async () => {
  const { warnings, log } = logged();
  const heard: string[] = [];
  const failing: AgentPlugin = {
    name: "failing",
    inject: ["prompt", "agent"],
    apply(ctx: Context) {
      ctx.prompt.section({
        name: "broken",
        text: () => {
          throw new Error("no words");
        },
      });
      ctx.on("agent/turn-ended", () => {
        throw new Error("can't hear");
      });
      ctx.on("agent/turn-ended", async () => Promise.reject(new Error("later")));
    },
  };
  const listening: AgentPlugin = {
    name: "listening",
    inject: ["agent"],
    apply(ctx: Context) {
      ctx.on("agent/turn-ended", ({ work }) => void heard.push(work ?? ""));
    },
  };
  const both = [{ plugin: failing }, { plugin: listening }];
  const plugins = await holding("a", memory().store, both, carrying(both, log));
  assert.deepEqual(plugins.blocks(), []);
  plugins.life("turnEnded", { work: "w1" });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(heard, ["w1"]);
  assert.ok(warnings.includes("A plugin's section couldn't be read; the request goes without it."));
  assert.equal(warnings.filter((one) => one === "A plugin failed on the agent's life.").length, 2);
});

test("a plugin that fails to load leaves nothing loaded, and holding it fails with it", async () => {
  const loaded: string[] = [];
  const first: AgentPlugin = {
    name: "first",
    inject: ["agent"],
    apply(ctx: Context) {
      loaded.push("first");
      ctx.effect(() => () => void loaded.push("first gone"));
    },
  };
  const broken: AgentPlugin = {
    name: "broken",
    inject: ["agent"],
    apply(ctx: Context) {
      ctx.effect(() => () => void loaded.push("broken gone"));
      throw new Error("won't load");
    },
  };
  await assert.rejects(holding("a", memory().store, [{ plugin: first }, { plugin: broken }]));
  assert.deepEqual(loaded.sort(), ["broken gone", "first", "first gone"]);
});

test("an agent holds the plugins named: one newly named is loaded, one no longer named unloaded, one named with other settings loaded again, and the rest stay as they are", async () => {
  const said: string[] = [];
  const host = createPluginHost(quiet, [saying("one", said), saying("two", said)]);
  const plugins = await host.open("a", { store: memory().store });
  const offered = () => plugins.tools().map(({ slot }) => slot);
  await plugins.hold([{ name: "one" }]);
  assert.deepEqual(said.splice(0), ["one loaded"]);
  // Named again as it is, it stays loaded; the one newly named beside it is loaded. Holding gives
  // what they then give.
  const given = await plugins.hold([{ name: "one" }, { name: "two", settings: { as: "first" } }]);
  assert.deepEqual(said.splice(0), ["two loaded as first"]);
  assert.deepEqual(
    given.tools.map(({ slot }) => slot),
    ["one", "two"],
  );
  assert.deepEqual(offered(), ["one", "two"]);
  // Other settings load that one again; the same named in another order, or with empty settings
  // where it had none, changes nothing.
  await plugins.hold([{ name: "one" }, { name: "two", settings: { as: "second" } }]);
  assert.deepEqual(said.splice(0), ["two unloaded", "two loaded as second"]);
  await plugins.hold([
    { name: "two", settings: { as: "second" } },
    { name: "one", settings: {} },
  ]);
  assert.deepEqual(said.splice(0), []);
  // No longer named, it is unloaded, and what it gave goes with it.
  await plugins.hold([{ name: "two", settings: { as: "second" } }]);
  assert.deepEqual(said.splice(0), ["one unloaded"]);
  assert.deepEqual(offered(), ["two"]);
  // Asked at once, the changes are made one after another: the last asked is what it holds.
  await Promise.all([plugins.hold([]), plugins.hold([{ name: "one" }])]);
  assert.deepEqual(said.splice(0), ["two unloaded", "one loaded"]);
  // Closed, it holds nothing, and is told nothing more.
  await plugins.close();
  await plugins.hold([{ name: "two" }]);
  assert.deepEqual(said.splice(0), ["one unloaded"]);
  assert.deepEqual(offered(), []);
});

test("a name the host doesn't carry is refused with the reason, and nothing it holds changes", async () => {
  const said: string[] = [];
  const plugins = await createPluginHost(quiet, [saying("one", said)]).open("a", {
    store: memory().store,
  });
  await plugins.hold([{ name: "one" }]);
  await assert.rejects(
    plugins.hold([{ name: "memory" }, { name: "search" }]),
    /^Error: This provider carries no plugin named memory, search\.$/,
  );
  // What it held stays, though it was no longer named.
  assert.deepEqual(said, ["one loaded"]);
  assert.equal(plugins.tools().length, 1);
  await plugins.close();
});

test("a function of a plugin that was unloaded answers that it is no longer held, and nothing of the plugin runs", async () => {
  const said: string[] = [];
  const plugins = await createPluginHost(quiet, [saying("one", said)]).open("a", {
    store: memory().store,
  });
  const [tool] = (await plugins.hold([{ name: "one" }])).tools;
  assert.deepEqual(await tool?.run({}, "g1"), { output: "Done.", ok: true });
  // A turn keeps the functions it was offered: its call comes after the plugin went.
  await plugins.hold([]);
  assert.deepEqual(await tool?.run({}, "g2"), {
    output: "The function one__do is no longer held.",
    ok: false,
  });
  assert.deepEqual(said, ["one loaded", "one did", "one unloaded"]);
  await plugins.close();
});

test("a plugin that was unloaded reaches the agent's services no more, though it kept hold of one", async () => {
  const kept: Context["store"][] = [];
  const keeping: AgentPlugin = {
    name: "keeping",
    inject: ["store"],
    apply(ctx: Context) {
      kept.push(ctx.store);
    },
  };
  const { store, values } = memory();
  const plugins = await holding("a", store, [{ plugin: keeping }]);
  await kept[0]?.set({ key: "note", value: "Kept while held." });
  assert.equal(values.get("plugin/keeping/note"), "Kept while held.");
  await plugins.hold([]);
  assert.throws(
    () => kept[0]?.set({ key: "note", value: "Kept after." }),
    /Only a plugin the agent holds may use its services\./,
  );
  assert.equal(values.get("plugin/keeping/note"), "Kept while held.");
  await plugins.close();
});

test("a plugin that waits for another's service is held whatever the order they are named in, and again when that one is loaded again", async () => {
  const said: string[] = [];
  // One that takes a moment to load, as one that reads its store first does.
  const slow: AgentPlugin = {
    name: "slow",
    inject: ["tally", "prompt"],
    async apply(ctx: Context) {
      await new Promise((done) => setTimeout(done, 20));
      said.push("slow loaded");
      ctx.prompt.section({ name: "count", text: () => `Counted ${ctx.tally.count}.` });
    },
  };
  const plugins = await createPluginHost(quiet, [slow, tally]).open("a", {
    store: memory().store,
  });
  const told = async (settings?: Record<string, unknown>) =>
    (
      await plugins.hold([{ name: "slow" }, { name: "tally", ...(settings ? { settings } : {}) }])
    ).blocks.map(({ text }) => text);
  // Named before the plugin whose service it waits for: it is still loading when that one is.
  assert.deepEqual(await told(), ["Counted 0."]);
  // That plugin is loaded again, with other settings: it loads again after it, and is held.
  assert.deepEqual(await told({ from: 1 }), ["Counted 0."]);
  assert.deepEqual(said, ["slow loaded", "slow loaded"]);
  await plugins.close();
});

test("what a plugin reaches as `agent` is the agent's id alone: its life is the host's to say", () => {
  assert.deepEqual(Object.getOwnPropertyNames(Agent.prototype).sort(), ["constructor", "id"]);
});

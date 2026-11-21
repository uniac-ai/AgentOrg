import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "cordis";
import { type AgentPlugin, createPluginHost, type Life, NO_PLUGINS } from "../src/plugins.ts";

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

/** A plugin that gives a function and a block, keeps what it is told, and writes what it hears. */
const notes: AgentPlugin<{ greeting: string }> = {
  name: "notes",
  inject: ["agent"],
  apply(ctx: Context, { greeting }) {
    let count = 0;
    ctx.effect(() =>
      ctx.agent.tool({
        name: "keep",
        description: "Keeps a note.",
        parameters: { type: "object", properties: { text: { type: "string" } } },
        async run(input) {
          count += 1;
          await ctx.agent.store.set({ key: "last", value: (input as { text: string }).text });
          return { output: "Kept.", ok: true } as never;
        },
      }),
    );
    ctx.effect(() => ctx.agent.block(() => `${greeting} ${ctx.agent.agent}: ${count} kept.`));
    for (const event of [
      "turnStarted",
      "turnEnded",
      "compacting",
      "compacted",
      "idle",
      "stopped",
    ] as Life[])
      ctx.effect(() =>
        ctx.agent.on(event, ({ work }) =>
          ctx.agent.store.set({ key: `heard/${event}`, value: work ?? null }),
        ),
      );
  },
};

test("an agent with no plugins is given nothing and hears nothing: its requests are as they were", async () => {
  const { store } = memory();
  const plugins = await createPluginHost(quiet).open("a", { store, plugins: [] });
  assert.equal(plugins, NO_PLUGINS);
  assert.deepEqual(plugins.tools(), []);
  assert.deepEqual(plugins.blocks(), []);
});

test("a plugin gives its agent a function under its own name, a block read afresh, a store of its own, and hears its life", async () => {
  const { store, values } = memory();
  const plugins = await createPluginHost(quiet).open("a", {
    store,
    plugins: [{ plugin: notes, config: { greeting: "Hello" } }],
  });
  const [tool] = plugins.tools();
  assert.equal(tool?.slot, "notes");
  assert.equal(tool?.name, "keep");
  assert.deepEqual(plugins.blocks(), [{ owner: "plugin:notes", text: "Hello a: 0 kept." }]);
  await tool?.run({ text: "Buy milk." }, "g1");
  // The block is read for each request: it says what changed since.
  assert.deepEqual(plugins.blocks(), [{ owner: "plugin:notes", text: "Hello a: 1 kept." }]);
  // Its store is its own, under the agent's.
  assert.equal(values.get("plugin/notes/last"), "Buy milk.");
  plugins.life("turnStarted", { work: "w1" });
  plugins.life("idle");
  await new Promise((done) => setImmediate(done));
  assert.equal(values.get("plugin/notes/heard/turnStarted"), "w1");
  assert.equal(values.get("plugin/notes/heard/idle"), null);
});

test("each agent's plugins are its own: one agent's give another nothing, and closing one leaves the other", async () => {
  const host = createPluginHost(quiet);
  const a = await host.open("a", {
    store: memory().store,
    plugins: [{ plugin: notes, config: { greeting: "Hi" } }],
  });
  const b = await host.open("b", {
    store: memory().store,
    plugins: [{ plugin: notes, config: { greeting: "Yo" } }],
  });
  assert.deepEqual(
    a.blocks().map(({ text }) => text),
    ["Hi a: 0 kept."],
  );
  assert.deepEqual(
    b.blocks().map(({ text }) => text),
    ["Yo b: 0 kept."],
  );
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
    ctx.provide("naming", { name: ctx.agent.agent });
  },
};
/** A plugin that uses both services its agent's other plugins provide, and says them in a block. */
const counting: AgentPlugin = {
  name: "counting",
  inject: ["agent", "tally", "naming"],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.agent.tool({
        name: "count",
        parameters: { type: "object", properties: {} },
        async run() {
          ctx.tally.add();
          return { output: "Counted.", ok: true } as never;
        },
      }),
    );
    ctx.effect(() => ctx.agent.block(() => `${ctx.naming.name} counted ${ctx.tally.count}.`));
  },
};

test("a service one plugin provides is its agent's alone: two agents holding the same plugins each have their own, and it goes with its agent", async () => {
  const host = createPluginHost(quiet);
  // Two services, used by a plugin listed before the plugins that provide them.
  const held = [{ plugin: counting }, { plugin: tally }, { plugin: naming }];
  const a = await host.open("a", { store: memory().store, plugins: held });
  const b = await host.open("b", { store: memory().store, plugins: held });
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
  const c = await host.open("c", { store: memory().store, plugins: held });
  assert.deepEqual(
    c.blocks().map(({ text }) => text),
    ["c counted 0."],
  );
  await b.close();
  await c.close();
});

test("a plugin that needs a service none of the agent's plugins provides fails the agent's open, and leaves nothing loaded", async () => {
  const host = createPluginHost(quiet);
  await assert.rejects(
    host.open("a", { store: memory().store, plugins: [{ plugin: tally }, { plugin: counting }] }),
    /counting needs a service none of the agent's plugins provides/,
  );
  // What loaded is gone: the same plugins load again for the agent, as they would on its next start.
  const again = await host.open("a", {
    store: memory().store,
    plugins: [{ plugin: tally }, { plugin: naming }, { plugin: counting }],
  });
  assert.deepEqual(
    again.blocks().map(({ text }) => text),
    ["a counted 0."],
  );
  await again.close();
});

test("a plugin's failures are logged, never the agent's: a block that throws is left out, a listener that throws doesn't stop the others", async () => {
  const { warnings, log } = logged();
  const heard: string[] = [];
  const failing: AgentPlugin = {
    name: "failing",
    inject: ["agent"],
    apply(ctx: Context) {
      ctx.effect(() =>
        ctx.agent.block(() => {
          throw new Error("no words");
        }),
      );
      ctx.effect(() =>
        ctx.agent.on("turnEnded", () => {
          throw new Error("can't hear");
        }),
      );
      ctx.effect(() => ctx.agent.on("turnEnded", async () => Promise.reject(new Error("later"))));
    },
  };
  const listening: AgentPlugin = {
    name: "listening",
    inject: ["agent"],
    apply(ctx: Context) {
      ctx.effect(() => ctx.agent.on("turnEnded", ({ work }) => void heard.push(work ?? "")));
    },
  };
  const plugins = await createPluginHost(log).open("a", {
    store: memory().store,
    plugins: [{ plugin: failing }, { plugin: listening }],
  });
  assert.deepEqual(plugins.blocks(), []);
  plugins.life("turnEnded", { work: "w1" });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(heard, ["w1"]);
  assert.ok(warnings.includes("A plugin's block couldn't be read; the request goes without it."));
  assert.equal(warnings.filter((one) => one === "A plugin failed on the agent's life.").length, 2);
});

test("a plugin that fails to load leaves nothing loaded, and the agent's open fails with it", async () => {
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
  await assert.rejects(
    createPluginHost(quiet).open("a", {
      store: memory().store,
      plugins: [{ plugin: first }, { plugin: broken }],
    }),
  );
  assert.deepEqual(loaded.sort(), ["broken gone", "first", "first gone"]);
});

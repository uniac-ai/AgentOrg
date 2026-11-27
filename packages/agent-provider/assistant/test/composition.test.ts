import assert from "node:assert/strict";
import test from "node:test";
import { type Context, Service } from "cordis";
import { type Capability, createPluginHost, type Held } from "../src/plugins.ts";

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
const BUNDLED = ["agent", "store", "tools", "prompt"];
/** What the agent holds besides what every agent does, each by what it says. */
const beyond = (held: Held[]) =>
  held
    .filter(({ name }) => !BUNDLED.includes(name))
    .map(({ name, title, state, detail, parent, kind }) => ({
      name: name.replace(/-\d+$/, "-#"),
      title,
      state,
      ...(detail ? { detail } : {}),
      ...(parent ? { parent } : {}),
      ...(kind ? { kind } : {}),
    }));

class Gauge extends Service {
  constructor(ctx: Context) {
    super(ctx, "gauge");
  }
}

test("what an agent is made of lists each plugin a capability loaded under it, by its own name and the number Cordis gave it; what a plugin loads is part of it, and services, child capabilities and unnamed blocks aren't plugins", async () => {
  const leaf = (ctx: Context) => void ctx.effect(() => () => {});
  function linesWatcher(ctx: Context) {
    ctx.plugin(leaf);
  }
  function named(_ctx: Context) {}
  const keeper: Capability = {
    name: "keeper",
    title: "Keeper",
    inject: ["capabilities"],
    async apply(ctx) {
      ctx.plugin(linesWatcher);
      ctx.plugin((_inner: Context) => {});
      ctx.plugin({
        name: "broken",
        apply() {
          throw new Error("No.");
        },
      });
      ctx.plugin({ name: "indexer", inject: ["nothing"], apply() {} });
      ctx.inject(["capabilities"], (_inner) => {});
      ctx.inject(["capabilities"], named);
      await ctx.use(Gauge);
      await ctx.capabilities.mount({ name: "tidy", title: "Tidy", inject: [], apply() {} });
    },
  };
  const plugins = await createPluginHost(quiet, [keeper]).open("a", {
    store: memory(),
    provides: ["gauge"],
  });
  await plugins.hold([{ name: "keeper" }]);
  const held = plugins.list();
  assert.deepEqual(beyond(held), [
    { name: "keeper", title: "Keeper", state: "mounted" },
    {
      name: "lines-watcher-#",
      title: "linesWatcher",
      state: "mounted",
      parent: "keeper",
      kind: "plugin",
    },
    {
      name: "broken-#",
      title: "broken",
      state: "failed",
      detail: "It couldn't be loaded.",
      parent: "keeper",
      kind: "plugin",
    },
    {
      name: "indexer-#",
      title: "indexer",
      state: "down",
      detail: "It waits for a service it needs.",
      parent: "keeper",
      kind: "plugin",
    },
    // A named function given to ctx.inject reads as a plugin of that name.
    { name: "named-#", title: "named", state: "mounted", parent: "keeper", kind: "plugin" },
    { name: "tidy", title: "Tidy", state: "mounted", parent: "keeper" },
  ]);
  // Each name is unique in the agent and the same while it runs.
  const names = held.map(({ name }) => name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    plugins.list().map(({ name }) => name),
    names,
  );
  assert.ok(names.every((name) => /^[a-z][a-z0-9-]*$/.test(name) && name.length <= 64));
  await plugins.close();
});

test("each part says what it added to the latest request, of what was offered: a plugin's function and section are its own, a capability's its own, and none is said before a request", async () => {
  function lines(ctx: Context) {
    ctx.tools.register({
      name: "edit",
      parameters: { type: "object" },
      run: async () => ({ output: "", ok: true }),
    });
    ctx.prompt.section({ name: "lines", text: () => "- The person is Sam." });
  }
  const keeper: Capability = {
    name: "keeper",
    inject: ["tools", "prompt", "context"],
    apply(ctx) {
      ctx.plugin(lines);
      ctx.tools.register({
        name: "forget",
        parameters: { type: "object" },
        run: async () => ({ output: "", ok: true }),
      });
      ctx.tools.register({
        name: "spare",
        parameters: { type: "object" },
        run: async () => ({ output: "", ok: true }),
      });
      ctx.context.pass(
        (request) => void request.instructions.push({ owner: "keeper-note", text: "Keep it." }),
      );
    },
  };
  const plugins = await createPluginHost(quiet, [keeper]).open("a", { store: memory() });
  await plugins.hold([{ name: "keeper" }]);
  assert.ok(plugins.list().every(({ added }) => added === undefined));
  plugins.pass({ instructions: [], functions: [], input: [], leftOut: [] });
  // The request offered all but one of them.
  plugins.offered?.(["keeper__edit", "keeper__forget"]);
  const added = Object.fromEntries(
    plugins.list().map(({ name, added: what }) => [name.replace(/-\d+$/, "-#"), what]),
  );
  assert.deepEqual(added["keeper"], { functions: ["keeper__forget"], sections: ["keeper-note"] });
  assert.deepEqual(added["lines-#"], { functions: ["keeper__edit"], sections: ["lines"] });
  assert.deepEqual(added["tools"], { functions: [], sections: [] });
  await plugins.close();
});

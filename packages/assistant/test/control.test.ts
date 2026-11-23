import assert from "node:assert/strict";
import test from "node:test";
import { agents } from "@agentorg/interfaces";
import { describeInterface, Refused } from "@agentorg/sdk";
import type { Context } from "cordis";
import { control } from "../src/capabilities/control.ts";
import { type AgentHub, type Model, model } from "../src/connector.ts";
import { type Capability, createPluginHost } from "../src/plugins.ts";
import type { Candidate } from "../src/tools.ts";

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
const SELF = "act_self";
const EXECUTOR = "act_executor";
const MEMORY = {
  provider: EXECUTOR,
  id: "memory",
  title: "Memory",
  description: "It remembers what you tell it to.",
  arguments: { type: "object" as const, properties: {} },
};
const GITHUB = {
  provider: EXECUTOR,
  id: "github",
  title: "GitHub",
  description: "Its repositories.",
  arguments: {
    type: "object" as const,
    properties: { owner: { type: "string" }, token: { type: "string", secret: true } },
    required: ["owner", "token"],
  },
};
const NOTES = {
  provider: EXECUTOR,
  id: "notes",
  title: "Notes",
  description: "Notes, with a key if you have one.",
  arguments: {
    type: "object" as const,
    properties: { token: { type: "string", secret: true } },
  },
};

/** Management's agents@1 as a stand-in: what it was asked, and agents by whose they are. */
function management() {
  const asked: { method: string; input: unknown }[] = [];
  const parents: Record<string, string> = { act_kid: SELF, act_other: "act_someone" };
  const call = {
    capabilities: async () => ({ capabilities: [MEMORY, GITHUB, NOTES] }),
    get: async ({ agent }: { agent: string }) => {
      if (agent !== SELF && !parents[agent]) throw new Refused("unknown", `No agent ${agent}.`);
      return {
        agent,
        ...(parents[agent] ? { parent: { agent: parents[agent], name: "Maker" } } : {}),
        mounted: [
          {
            mounted: `mnt_${agent}`,
            provider: EXECUTOR,
            capability: "memory",
            title: "Memory",
            arguments: {},
            by: agent,
            state: "mounted",
            children: [],
          },
        ],
      };
    },
    mount: async (input: unknown) => {
      asked.push({ method: "mount", input });
      return { mounted: "mnt_new" };
    },
    unmount: async (input: unknown) => {
      asked.push({ method: "unmount", input });
      return {};
    },
  };
  return { asked, call };
}

/** An agent holding control, reaching `reached` as management's agents@1 if it is given. */
async function holding(reached?: object) {
  const exposed = reached
    ? [
        {
          slot: "agents",
          described: describeInterface(agents),
          provider: { actor: "act_management", export: "agents" },
          call: reached,
          on: () => () => {},
        },
      ]
    : [];
  const hub = { exposed: () => exposed, onExposed: () => () => {} } as unknown as AgentHub;
  const connector: Capability = {
    name: "connector",
    inject: [],
    provide: "hub",
    apply: (ctx: Context) => void ctx.provide("hub", hub),
  };
  const plugins = await createPluginHost(quiet, [control()]).open(SELF, {
    store: memory(),
    provides: ["hub"],
  });
  await plugins.mount(connector);
  await plugins.hold([{ name: "control" }]);
  const functions = new Map<string, Candidate>(
    plugins.tools().map((one) => [`${one.slot}__${one.name}`, one]),
  );
  const run = async (name: string, input: object) => {
    const fn = functions.get(`control__${name}`);
    assert.ok(fn, name);
    return fn.run(input, "group");
  };
  return { plugins, functions, run };
}

test("control lists what may be mounted and what is mounted, and mounts and unmounts on the agent itself and on an agent it made, and on no other", async () => {
  const { asked, call } = management();
  const { plugins, functions, run } = await holding(call);
  assert.deepEqual(
    [...functions.keys()],
    ["control__capability_list", "control__capability_mount", "control__capability_unmount"],
  );
  const listed = await run("capability_list", {});
  assert.equal(listed.ok, true);
  const { capabilities, mounted } = JSON.parse(listed.output);
  assert.deepEqual(
    capabilities.map((one: { id: string }) => one.id),
    ["memory", "github", "notes"],
  );
  assert.deepEqual(
    mounted.map((one: { mounted: string }) => one.mounted),
    [`mnt_${SELF}`],
  );
  // On itself, and on the agent it made.
  for (const agent of [undefined, "act_kid"]) {
    const on = agent ?? SELF;
    const made = await run("capability_mount", {
      ...(agent ? { agent } : {}),
      provider: EXECUTOR,
      capability: "memory",
    });
    assert.deepEqual(made, { output: JSON.stringify({ mounted: "mnt_new" }), ok: true });
    assert.deepEqual(asked.at(-1), {
      method: "mount",
      input: { agent: on, provider: EXECUTOR, capability: "memory", arguments: {} },
    });
    assert.equal(
      (await run("capability_unmount", { ...(agent ? { agent } : {}), mounted: "mnt_new" })).ok,
      true,
    );
    assert.deepEqual(asked.at(-1), { method: "unmount", input: { agent: on, mounted: "mnt_new" } });
  }
  // Another's agent, or one there isn't: refused, and management is asked nothing more.
  const before = asked.length;
  for (const name of ["capability_list", "capability_mount", "capability_unmount"]) {
    const refused = await run(name, {
      agent: "act_other",
      provider: EXECUTOR,
      capability: "memory",
      mounted: "mnt_act_other",
    });
    assert.equal(refused.ok, false, name);
    assert.equal(refused.code, "forbidden", name);
    assert.equal(
      refused.output,
      "You can mount and unmount only on yourself and on agents you made, and you didn't make act_other.",
    );
  }
  assert.equal((await run("capability_list", { agent: "act_none" })).code, "unknown");
  assert.equal(asked.length, before);
  await plugins.close();
});

test("a capability that needs a key isn't mounted: the agent is told to tell the person it needs theirs, given in Setup", async () => {
  const { asked, call } = management();
  const { plugins, run } = await holding(call);
  const words = (title: string) =>
    `${title} needs a key, which you don't hold and can't be given here: only the person gives it, in Setup. Nothing was mounted. Tell them, in your own words, that you need their key for ${title}, given in Setup.`;
  // One whose key is required, with or without a key given.
  for (const given of [{ owner: "o" }, { owner: "o", token: "tok" }])
    assert.deepEqual(
      await run("capability_mount", { provider: EXECUTOR, capability: "github", arguments: given }),
      { output: words("GitHub"), ok: false, code: "needs_key" },
    );
  // One whose key is optional is mounted without one, and refused with one.
  assert.equal(
    (await run("capability_mount", { provider: EXECUTOR, capability: "notes", arguments: {} })).ok,
    true,
  );
  assert.deepEqual(
    await run("capability_mount", {
      provider: EXECUTOR,
      capability: "notes",
      arguments: { token: "tok" },
    }),
    { output: words("Notes"), ok: false, code: "needs_key" },
  );
  assert.deepEqual(
    asked.map(({ method, input }) => [method, (input as { capability: string }).capability]),
    [["mount", "notes"]],
  );
  await plugins.close();
});

test("with management's agents@1 not exposed to it, control says it can't be reached", async () => {
  const { plugins, run } = await holding();
  assert.deepEqual(await run("capability_list", {}), {
    output: "Management can't be reached now.",
    ok: false,
    code: "not_connected",
  });
  await plugins.close();
});

test("the agent's loops ask through its model capability: a loop's request goes as the looper made it, under its own id and model, and so does its cancel", async () => {
  const asked: { method: string; input: unknown }[] = [];
  let bound = true;
  const hub = {
    exposed: () => [],
    onExposed: () => () => {},
    slots: {
      model: {
        get bound() {
          return bound;
        },
        call: {
          respond: async (input: unknown) => {
            asked.push({ method: "respond", input });
            return { output: [] };
          },
          cancel: async (input: unknown) => {
            asked.push({ method: "cancel", input });
            return {};
          },
        },
      },
    },
  } as unknown as AgentHub;
  const plugins = await createPluginHost(quiet, []).open(SELF, {
    store: memory(),
    provides: ["hub", "model"],
  });
  await plugins.mount({
    name: "connector",
    inject: [],
    provide: "hub",
    apply: (ctx: Context) => void ctx.provide("hub", hub),
  });
  await plugins.mount(model(async () => "chosen"));
  const service = plugins.service?.("model") as Model;
  const request = {
    requestId: "loop-1",
    model: "large",
    instructions: "Be brief.",
    input: [{ type: "message" as const, role: "user" as const, content: "Hi." }],
    tools: [],
  };
  assert.deepEqual(await service.request(request), { output: [] });
  await service.cancel({ requestId: "loop-1" });
  assert.deepEqual(asked, [
    { method: "respond", input: request },
    { method: "cancel", input: { requestId: "loop-1" } },
  ]);
  // With no model bound, there is nothing to stop.
  bound = false;
  assert.deepEqual(await service.cancel({ requestId: "loop-2" }), {});
  assert.equal(asked.length, 2);
  await plugins.close();
});

test("control tells the agent, once a turn, what it can mount and what it holds, by id and description, asking management only what is on offer and nothing of the agent; with management away, nothing", async () => {
  const { call } = management();
  // Each call management is asked, by its name.
  const asked: string[] = [];
  const counted = Object.fromEntries(
    Object.entries(call).map(([name, fn]) => [
      name,
      (input: never) => {
        asked.push(name);
        return (fn as (input: never) => unknown)(input);
      },
    ]),
  );
  let reached: object | undefined = counted;
  const exposed = () =>
    reached
      ? [
          {
            slot: "agents",
            described: describeInterface(agents),
            provider: { actor: "act_management", export: "agents" },
            call: reached,
            on: () => () => {},
          },
        ]
      : [];
  const hub = { exposed, onExposed: () => () => {} } as unknown as AgentHub;
  // What it holds is its own: here, memory beside control.
  const held: Capability = { name: "memory", inject: [], apply() {} };
  const plugins = await createPluginHost(quiet, [control(), held]).open(SELF, {
    store: memory(),
    provides: ["hub"],
  });
  await plugins.mount({
    name: "connector",
    inject: [],
    provide: "hub",
    apply: (ctx: Context) => void ctx.provide("hub", hub),
  });
  await plugins.hold([{ name: "control" }, { name: "memory" }]);
  const told = () =>
    plugins
      .pass({ instructions: [], functions: [], input: [], leftOut: [] })
      .instructions.filter(({ owner }) => owner === "plugin:control/capabilities")
      .map(({ text }) => text);
  const list = `## Capabilities
A capability gives you more to do and know, from your next message. Mount one on yourself with control__capability_mount when what you're asked needs it, and take it off with control__capability_unmount.
- memory (Memory, mounted): It remembers what you tell it to.
- github (GitHub): Its repositories.
- notes (Notes): Notes, with a key if you have one.`;
  await plugins.turn();
  assert.deepEqual(told(), [list]);
  // The first turn waited for what is on offer; the next waits for nothing of management's, and
  // reads it again behind itself. No turn asks management of the agent.
  await plugins.turn();
  assert.deepEqual(told(), [list]);
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(asked, ["capabilities", "capabilities"]);
  reached = undefined;
  await plugins.turn();
  assert.deepEqual(told(), []);
  await plugins.close();
});

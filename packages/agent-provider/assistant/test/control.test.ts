import assert from "node:assert/strict";
import test from "node:test";
import { tools } from "@agentorg/interfaces";
import { describeInterface } from "@agentorg/sdk";
import type { Context } from "cordis";
import { connections } from "../src/capabilities/connections.ts";
import { control } from "../src/capabilities/control.ts";
import { OFFERED_MAX, offered } from "../src/capabilities/offered.ts";
import { type AgentHub, type Model, model } from "../src/connector.ts";
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
const SELF = "act_self";
const WORDS = `## Capabilities
A capability gives you more to do and know, from your next message.
- memory (Memory, mounted): It remembers what you tell it to.`;

/** The three tools management lists at `control` to an agent holding control, by name. */
const THREE = ["capability_list", "capability_mount", "capability_unmount"];

/** Management's tools at `control`, as a stand-in: what it was asked, and how it answers. */
function management() {
  const asked: unknown[] = [];
  const call = {
    list: async () => ({
      tools: THREE.map((name) => ({ name, inputSchema: { type: "object" } })),
    }),
    call: async (input: { name: string }) => {
      asked.push(input);
      return { output: JSON.stringify({ capabilities: [] }) };
    },
    stop: async () => ({}),
  };
  return { asked, call };
}

/**
 * An agent holding control, with what else it holds, and `reached` as management's tools at
 * `control` if it is given: what each request is told of what it can mount.
 */
async function holding(reached?: object, others: Capability[] = []) {
  const exposed = reached
    ? [
        {
          slot: "control",
          described: describeInterface(tools),
          provider: { actor: "act_management", export: "tools" },
          call: reached,
          on: () => () => {},
        },
      ]
    : [];
  const hub = { exposed: () => exposed, onExposed: () => () => {} } as unknown as AgentHub;
  const plugins = await createPluginHost(quiet, [control(), ...others]).open(SELF, {
    store: memory(),
    provides: ["hub"],
  });
  await plugins.mount({
    name: "connector",
    inject: [],
    provide: "hub",
    apply: (ctx: Context) => void ctx.provide("hub", hub),
  });
  const told = () =>
    plugins
      .pass({ instructions: [], functions: [], input: [], leftOut: [] })
      .instructions.filter(({ owner }) => owner.endsWith("/capabilities"))
      .map(({ text }) => text);
  return { plugins, told };
}

test("control offers no function of its own: its three are management's tools at control, which connections offers once, and a call runs through that slot", async () => {
  const { asked, call } = management();
  const { plugins } = await holding(call);
  await plugins.mount(connections());
  await plugins.hold([{ name: "control" }]);
  assert.deepEqual(plugins.tools(), []);
  await plugins.turn();
  const { functions } = plugins.pass({ instructions: [], functions: [], input: [], leftOut: [] });
  assert.deepEqual(
    functions.map(({ slot, name }) => `${slot}__${name}`),
    THREE.map((name) => `control__${name}`),
  );
  assert.deepEqual(await functions[0]?.run({ agent: "act_kid" }, "group"), {
    output: JSON.stringify({ capabilities: [] }),
    ok: true,
  });
  assert.deepEqual(asked, [
    { name: "capability_list", arguments: { agent: "act_kid" }, group: "group" },
  ]);
  await plugins.close();
});

test("offered tells what management says the agent can mount as its own section, where control told it, and nothing when none is on offer; control tells nothing itself", async () => {
  const { call } = management();
  const { plugins, told } = await holding(call, [offered()]);
  const tellers = () =>
    plugins
      .pass({ instructions: [], functions: [], input: [], leftOut: [] })
      .instructions.filter(({ owner }) => owner.endsWith("/capabilities"))
      .map(({ owner, max }) => [owner, max]);
  await plugins.hold([{ name: "offered", settings: { text: WORDS } }, { name: "control" }]);
  assert.deepEqual(told(), [WORDS]);
  assert.deepEqual(tellers(), [["plugin:offered/capabilities", OFFERED_MAX]]);
  // None on offer: nothing is told.
  await plugins.hold([{ name: "offered", settings: {} }, { name: "control" }]);
  assert.deepEqual(told(), []);
  await plugins.hold([{ name: "control" }]);
  assert.deepEqual(told(), []);
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

import assert from "node:assert/strict";
import test from "node:test";
import { tools } from "@agentorg/interfaces";
import { describeInterface, Refused } from "@agentorg/sdk";
import type { Context } from "cordis";
import { control } from "../src/capabilities/control.ts";
import { OFFERED_MAX, offered } from "../src/capabilities/offered.ts";
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
const WORDS = `## Capabilities
A capability gives you more to do and know, from your next message.
- memory (Memory, mounted): It remembers what you tell it to.`;

/** Management's tools at `control`, as a stand-in: what it was asked, and how it answers each. */
function management() {
  const asked: unknown[] = [];
  const call = {
    list: async () => ({ tools: [] }),
    call: async (input: { name: string }) => {
      asked.push(input);
      if (input.name === "capability_mount")
        throw new Refused("needs_key", "GitHub needs a key, which you don't hold.");
      if (input.name === "capability_unmount")
        return { output: "It ran and failed.", failed: true };
      return { output: JSON.stringify({ capabilities: [] }) };
    },
    stop: async () => ({}),
  };
  return { asked, call };
}

/**
 * An agent holding control, with what else it holds, and `reached` as management's tools at
 * `control` if it is given: what each request is told of what it can mount, and its functions.
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
  const functions = () =>
    new Map<string, Candidate>(plugins.tools().map((one) => [`${one.slot}__${one.name}`, one]));
  return { plugins, told, functions };
}

test("control offers its three functions and runs each through management's tools at control: what each answers, fails or is refused is told as before; with none there, management can't be reached", async () => {
  const { asked, call } = management();
  const { plugins, functions } = await holding(call);
  await plugins.hold([{ name: "control" }]);
  const held = functions();
  assert.deepEqual(
    [...held.keys()],
    ["control__capability_list", "control__capability_mount", "control__capability_unmount"],
  );
  assert.deepEqual(held.get("control__capability_mount")?.parameters.required, [
    "provider",
    "capability",
  ]);
  const run = (name: string, input: object) =>
    (held.get(`control__${name}`) as Candidate).run(input, "group");
  assert.deepEqual(await run("capability_list", { agent: "act_kid" }), {
    output: JSON.stringify({ capabilities: [] }),
    ok: true,
  });
  assert.deepEqual(asked, [
    { name: "capability_list", arguments: { agent: "act_kid" }, group: "group" },
  ]);
  // What management refuses is told with its code; what ran and failed, as failed.
  assert.deepEqual(await run("capability_mount", { provider: "p", capability: "github" }), {
    output: "GitHub needs a key, which you don't hold.",
    ok: false,
    code: "needs_key",
  });
  assert.deepEqual(await run("capability_unmount", { mounted: "mnt_one" }), {
    output: "It ran and failed.",
    ok: false,
    code: "failed",
  });
  await plugins.close();

  const away = await holding();
  await away.plugins.hold([{ name: "control" }]);
  assert.deepEqual(await away.functions().get("control__capability_list")?.run({}, "group"), {
    output: "Management can't be reached now.",
    ok: false,
    code: "not_connected",
  });
  await away.plugins.close();
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

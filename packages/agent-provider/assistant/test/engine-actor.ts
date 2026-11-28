// The engine as the tests host it: an Actor with a store slot in place of a provider's own files,
// holding what an executor gives every agent: its connections and its summary, and its
// instructions and skills from the tree it is given.
import { capability, chat, kv, llmSession, type SettingsRoot, tools } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import { summary } from "@agentorg/summary";
import type { Context } from "cordis";
import type { z } from "zod";
import type { KvStore } from "../src/bundled.ts";
import { connections } from "../src/capabilities/connections.ts";
import { instructions } from "../src/capabilities/instructions.ts";
import { skills } from "../src/capabilities/skills.ts";
import { type AgentHub, model } from "../src/connector.ts";
import { startEngine } from "../src/engine.ts";
import { type AgentContext, type AgentPlugins, createPluginHost } from "../src/plugins.ts";

/** What the agent is told when it is given no tree. */
export const INSTRUCTIONS = "You are the agent under test.";
/** What its template gave before `INSTRUCTIONS`. */
export const EARLIER =
  "You are the agent under test, as its template once said.\nKeep replies short.";
/** The executor's own id: the roots of the tree its settings give that it holds name it. */
export const SELF = "act_executor";

/** Each engine started, the latest last, for a test to stop as its host would. */
export const engines: ReturnType<typeof startEngine>[] = [];
/**
 * The plugins the next engine started holds, as a test sets them, beside what an executor gives
 * every agent; by default, only that. And the tree of what is mounted on it, as its host was last
 * given it; by default, it is given none.
 */
export const given: {
  plugins?: AgentContext;
  mounted?: () => z.input<typeof SettingsRoot>[] | undefined;
} = {};

const quiet = { info() {}, warn() {}, error() {} };

/**
 * What an executor gives every agent, on the Actor's own channel, in `opened`, or in a context of
 * its own: ready once its connections and its summary are mounted.
 */
function everyAgent(
  hub: AgentHub,
  store: KvStore,
  chosen: () => Promise<string | undefined>,
  opened?: AgentContext,
) {
  let context: AgentContext | undefined;
  const ready = (async () => {
    const one =
      opened ??
      (await createPluginHost(quiet, [
        instructions({ now: () => INSTRUCTIONS, earlier: EARLIER }),
        skills(),
      ]).open("agent", { store, provides: ["hub", "model", "summary"] }));
    await one.mount({
      name: "connector",
      title: "Hub connector",
      inject: [],
      provide: "hub",
      apply: (ctx: Context) => void ctx.provide("hub", hub),
    });
    await one.mount(model(() => chosen()));
    await one.mount(connections());
    await one.mount(summary());
    context = one;
    return one;
  })();
  const plugins: AgentPlugins = {
    tools: () => context?.tools() ?? [],
    blocks: () => context?.blocks() ?? [],
    life: (event, heard) => context?.life(event, heard),
    hold: async (named) => (await ready).hold(named),
    close: async () => (await ready).close(),
    pass: (request) => (context ? context.pass(request) : request),
    turn: async (loop) => (await ready).turn(loop),
    service: (name) => context?.service?.(name),
    offered: (names) => context?.offered?.(names),
    reads: (read) => void ready.then((one) => one.reads?.(read)).catch(() => {}),
  };
  return { plugins, ready };
}

export default defineActor({
  slots: { model: llmSession, store: kv },
  exports: { chat, capability, tools },
  start(ctx) {
    const store = ctx.slots.store.call;
    // Its model capability asks with the model its engine has chosen.
    let engine: ReturnType<typeof startEngine> | undefined;
    const chosen = async () => engine?.chosen();
    const agent = everyAgent(ctx as unknown as AgentHub, store, chosen, given.plugins);
    const { mounted } = given;
    engine = startEngine(ctx, {
      store,
      instructions: () => INSTRUCTIONS,
      ...(mounted ? { mounted: mounted as () => z.infer<typeof SettingsRoot>[] | undefined } : {}),
      self: SELF,
      ...agent,
    });
    engines.push(engine);
  },
});

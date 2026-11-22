// The engine as the tests host it: an Actor with a store slot in place of a provider's own files,
// holding what an executor gives every agent: its connections, and its instructions and skills
// from the tree its settings give.
import { agentSettings2, capability, chat, kv, llmSession, tools } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import type { Context } from "cordis";
import type { KvStore } from "../src/bundled.ts";
import { connections } from "../src/capabilities/connections.ts";
import { instructions } from "../src/capabilities/instructions.ts";
import { skills } from "../src/capabilities/skills.ts";
import type { AgentHub } from "../src/connector.ts";
import { startEngine } from "../src/engine.ts";
import { type AgentContext, type AgentPlugins, createPluginHost } from "../src/plugins.ts";

/** What the agent is told while no `settings` is bound. */
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
 * every agent; by default, only that.
 */
export const given: { plugins?: AgentContext } = {};

const quiet = { info() {}, warn() {}, error() {} };

/**
 * What an executor gives every agent, on the Actor's own channel, in `opened`, or in a context of
 * its own: ready once its connections are mounted.
 */
function everyAgent(hub: AgentHub, store: KvStore, opened?: AgentContext) {
  let context: AgentContext | undefined;
  const ready = (async () => {
    const one =
      opened ??
      (await createPluginHost(quiet, [
        instructions({ now: () => INSTRUCTIONS, earlier: EARLIER }),
        skills(),
      ]).open("agent", { store, provides: ["hub"] }));
    await one.mount({
      name: "connector",
      title: "Hub connector",
      inject: [],
      provide: "hub",
      apply: (ctx: Context) => void ctx.provide("hub", hub),
    });
    await one.mount(connections());
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
  };
  return { plugins, ready };
}

export default defineActor({
  slots: { model: llmSession, store: kv, settings: agentSettings2 },
  exports: { chat, capability, tools },
  start(ctx) {
    const store = ctx.slots.store.call;
    const agent = everyAgent(ctx as unknown as AgentHub, store, given.plugins);
    engines.push(
      startEngine(ctx, {
        store,
        instructions: () => INSTRUCTIONS,
        self: SELF,
        ...agent,
      }),
    );
  },
});

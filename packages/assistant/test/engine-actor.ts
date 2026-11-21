// The engine as the tests host it: an Actor with a store slot in place of a provider's own files.
import { agentSettings, capability, chat, kv, llmSession, tools } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import { startEngine } from "../src/engine.ts";
import type { AgentPlugins } from "../src/plugins.ts";

/** What the agent is told while no `settings` is bound. */
export const INSTRUCTIONS = "You are the agent under test.";
/** What its template gave before `INSTRUCTIONS`. */
export const EARLIER =
  "You are the agent under test, as its template once said.\nKeep replies short.";

/** Each engine started, the latest last, for a test to stop as its host would. */
export const engines: ReturnType<typeof startEngine>[] = [];
/** The plugins the next engine started holds, as a test sets them; none by default. */
export const given: { plugins?: AgentPlugins } = {};

export default defineActor({
  slots: { model: llmSession, store: kv, settings: agentSettings },
  exports: { chat, capability, tools },
  start(ctx) {
    engines.push(
      startEngine(ctx, {
        store: ctx.slots.store.call,
        instructions: () => INSTRUCTIONS,
        earlier: EARLIER,
        ...(given.plugins ? { plugins: given.plugins } : {}),
      }),
    );
  },
});

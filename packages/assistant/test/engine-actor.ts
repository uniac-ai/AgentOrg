// The engine as the tests host it: an Actor with a store slot in place of a provider's own files.
import { agentSettings, capability, chat, kv, llmSession, tools } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import { startEngine } from "../src/engine.ts";

/** What the agent is told while no `settings` is bound. */
export const INSTRUCTIONS = "You are the agent under test.";

/** Each engine started, the latest last, for a test to stop as its host would. */
export const engines: ReturnType<typeof startEngine>[] = [];

export default defineActor({
  slots: { model: llmSession, store: kv, settings: agentSettings },
  exports: { chat, capability, tools },
  start(ctx) {
    engines.push(
      startEngine(ctx, { store: ctx.slots.store.call, instructions: () => INSTRUCTIONS }),
    );
  },
});

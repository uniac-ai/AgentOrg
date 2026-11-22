/**
 * Two capabilities the executor makes for each agent it runs, for that agent only:
 * - the Hub connector, which opens the agent's channel to the Hub with the identity the executor
 *   keeps for it and offers `hub`: what the agent reaches of the Hub through it;
 * - the model, on `hub`, which offers `model`: a capability's own question to the agent's model.
 * Neither takes arguments, so no caller can mount one with another agent's identity.
 */
import type {
  agentSettings,
  capability,
  chat,
  Item,
  llmSession,
  Tool,
  tools,
} from "@agentorg/interfaces";
import type { Context as HubContext, Slot } from "@agentorg/sdk";
import type { Context } from "cordis";
import type { z } from "zod";
import type { Capability } from "./substrate.js";

/** What the agent reaches of the Hub through its channel: its slots, its exports, what is exposed to it. */
export type AgentHub = Pick<
  HubContext<
    { model: typeof llmSession; settings: typeof agentSettings },
    { chat: typeof chat; capability: typeof capability; tools: typeof tools }
  >,
  "slots" | "exports" | "exposed" | "onExposed" | "log"
>;

/** An agent's channel to the Hub, as its connector keeps it. */
export interface Channel {
  close(): void;
  readonly closed: Promise<void>;
}

declare module "cordis" {
  interface Context {
    hub: AgentHub;
    model: Model;
  }
}

/**
 * The Hub connector. `join` opens the agent's channel, and calls `started` with what the agent
 * reaches through it before the channel opens; the connector offers that as `hub` once it is open,
 * and closes the channel as it goes. Once the channel ends, it says it is down, with why.
 */
export const connector = (
  join: (started: (hub: AgentHub) => void) => Promise<Channel>,
): Capability => ({
  name: "connector",
  title: "Hub connector",
  inject: ["capabilities"],
  provide: "hub",
  async apply(ctx: Context) {
    const { signal } = ctx.capabilities;
    let hub: AgentHub | undefined;
    const channel = await join((started) => {
      hub = started;
    });
    ctx.effect(() => () => channel.close());
    if (!hub) throw new Error("Its channel opened with nothing to reach the Hub through.");
    ctx.provide("hub", hub);
    void channel.closed.then(() => {
      if (!signal.aborted) ctx.capabilities.say("down", "Its connection to the Hub ended.");
    });
  },
});

type Respond = Slot<typeof llmSession>["call"]["respond"];
/** A capability's own question: its own words, its input, and the functions it offers. */
export interface Asked {
  instructions: string;
  input: z.input<typeof Item>[];
  tools?: z.input<typeof Tool>[];
}

/**
 * The agent's model, as its capabilities ask it. A question goes as asked: no pass runs on it, so
 * it carries the asking capability's own words only. It goes under the agent's own cache key, as
 * it goes through the agent's channel, with the model chosen for the agent. It is cancelled when
 * `signal` fires (a capability gives its own, `ctx.capabilities.signal`, so a question ends with
 * it), or when the agent stops.
 */
export interface Model {
  respond(asked: Asked, options?: { signal?: AbortSignal }): ReturnType<Respond>;
}

/**
 * The model capability. `chosen` reads the agent's model choice, which stays the engine's for now.
 */
export const model = (chosen: () => Promise<string | undefined>): Capability => ({
  name: "model",
  title: "Model",
  inject: ["hub"],
  provide: "model",
  apply(ctx: Context) {
    const { hub } = ctx;
    /** Each question out now, with how to cancel it. */
    const asking = new Map<string, () => void>();
    const service: Model = {
      async respond(asked, { signal } = {}) {
        if (signal?.aborted) throw new Error("It was cancelled before it was asked.");
        const requestId = `capability-${crypto.randomUUID()}`;
        const chose = await chosen();
        const cancel = () =>
          void hub.slots.model.call.cancel({ requestId }).catch(() => {
            // Gone already: nothing to stop.
          });
        signal?.addEventListener("abort", cancel, { once: true });
        asking.set(requestId, cancel);
        try {
          return await hub.slots.model.call.respond({
            requestId,
            ...(chose ? { model: chose } : {}),
            instructions: asked.instructions,
            input: asked.input,
            ...(asked.tools ? { tools: asked.tools } : {}),
          } as Parameters<Respond>[0]);
        } finally {
          signal?.removeEventListener("abort", cancel);
          asking.delete(requestId);
        }
      },
    };
    ctx.provide("model", service);
    ctx.on("agent/stopped", () => {
      for (const cancel of asking.values()) cancel();
    });
  },
});

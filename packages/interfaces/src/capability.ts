import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";
import { LiveMode, LiveSurface, LiveTicket } from "./units.js";

/**
 * `capability@1`: something an agent holds, as it stands now. One Actor per capability exports
 * it; the person is connected to it when the agent is built, as to the agent's chats, and the
 * page asks it through that binding. No unit is asked: this is the built agent's side.
 *
 * `state` says whether it can be reached, and which of its surfaces can be opened now. `live`
 * gives a one-time ticket to open one: only the person's gateway asks, and it dials the url
 * itself, so no ticket reaches a page. It is refused `unknown` for a surface the capability
 * doesn't have.
 */
export const capability = defineInterface({
  name: "capability",
  major: 1,
  kind: "rpc",
  methods: {
    state: method({
      input: z.object({}),
      output: z.object({
        state: z.enum(["connected", "connecting", "down"]),
        /** Why it can't be reached, when it can't. */
        detail: z.string().max(2000).optional(),
        surfaces: z.array(LiveSurface).max(16),
      }),
    }),
    live: method({
      input: z.object({ surface: z.string().min(1).max(64), mode: LiveMode }),
      output: LiveTicket,
    }),
  },
  events: {
    /** A view's data changed: ask again. With no view, its state did. */
    changed: event(z.object({ view: z.string().min(1).max(64).optional() })),
  },
});

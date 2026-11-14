import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";
import { FieldValues, LiveMode, LiveSurface, LiveTicket, UnitId } from "./units.js";

/**
 * A way to go on with a capability that can't be reached, when building it another way would mend
 * it: what to call it, what taking it does, and a unit of the provider that built the capability,
 * with the values to open that unit's form with. `values` holds no secret field's: the form asks
 * for those again. Offering it does nothing: the person looks at the form, prefilled, and saves it
 * in place of what the capability was built from, or doesn't.
 */
export const WayForward = z.strictObject({
  title: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  unit: UnitId,
  values: FieldValues,
});

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
        /** With `down`, the ways forward the person can take, in the order to offer them. */
        ways: z.array(WayForward).max(4).optional(),
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

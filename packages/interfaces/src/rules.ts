import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

/** A named rule's id: lowercase words joined by hyphens. */
const RuleId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
  .max(64);

/**
 * One named rule: a convenience the person turns on, off unless they do. `says` is what it does,
 * in the person's words.
 */
export const Rule = z.object({
  id: RuleId,
  name: z.string().max(200),
  says: z.string().max(1000),
  on: z.boolean(),
});

/**
 * `app.rules@1`: the person's named rules. Each is held by the person's Actor (the app's gateway),
 * which acts on a rule that is on as the person, a manager, and only within what the person could
 * grant. A rule is the only thing that may act on provenance such as an Actor's `installedFor`.
 */
export const appRules = defineInterface({
  name: "app.rules",
  major: 1,
  kind: "rpc",
  methods: {
    /** Every rule the app knows, each with whether it is on. */
    list: method({ input: z.object({}), output: z.object({ rules: z.array(Rule) }) }),
    /** Turn a rule on or off. Turning one on settles what already waits for it. */
    set: method({ input: z.object({ id: RuleId, on: z.boolean() }), output: z.object({}) }),
  },
  events: {
    /** A rule was turned on or off; read them again with `list`. */
    changed: event(z.object({})),
  },
});

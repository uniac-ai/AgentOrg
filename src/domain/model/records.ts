/** The records the core keeps and returns: actors, their interfaces, calls and the audit trail. */

import { z } from "zod";

/** The handle under which an actor sees its manager's interfaces, as in `manager.decide`. */
export const MANAGER = "manager";

/** Size caps. The core refuses longer text, which keeps logs out of the record. */
export const LIMITS = { id: 64, title: 200, text: 1000, summary: 2000, message: 20_000 } as const;

/** The longest a read may wait for what it waits on, in seconds. */
export const MAX_WAIT_SECONDS = 600;

const text = (max: number) => z.string().trim().min(1).max(max);

export const Id = text(LIMITS.id);
export const Text = text(LIMITS.text);
export const Timestamp = z.iso.datetime({ offset: true });

export const Handle = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a lowercase handle such as storage or web-ui")
  .refine((handle) => handle !== MANAGER, `${MANAGER} names an actor's manager`)
  .describe("A short handle, unique among its siblings, that names the actor in interface names.");

/** An interface's own name: no dots, since dots join handles and interface names. */
export const INTERFACE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const JsonSchema = z.record(z.string(), z.unknown()).describe("A JSON Schema.");

export const Interface = z
  .strictObject({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    input: JsonSchema.describe("The JSON Schema its input must match."),
    output: JsonSchema.optional().describe(
      "The JSON Schema its structured value must match; without it, the result is parts only.",
    ),
    one_way: z.boolean().describe("Its caller does not wait for its result."),
    long_running: z
      .boolean()
      .describe("It may finish long after the call, so the core waits on it as a run."),
  })
  .meta({ id: "Interface", description: "Something an actor exposes, which others call." });

export const Actor = z
  .strictObject({
    id: Id.describe("Issued by the core."),
    name: Handle,
    path: z
      .string()
      .describe(
        "The handles from the root's report down to this actor, joined by dots, as the root names it; empty for the root.",
      ),
    purpose: Text,
    manager: Id.nullable().describe("The managing actor; null for the root."),
    online: z.boolean().describe("True while the core can deliver calls to it."),
    interfaces: z.array(Interface).describe("Its exposed interfaces, as it last listed them."),
    created_at_attach: z
      .boolean()
      .describe(
        "Created when a session the user started attached to it, rather than by a manager's choice.",
      ),
    created_at: Timestamp,
    closed_at: Timestamp.nullable(),
  })
  .meta({ id: "Actor", description: "A position in the organization, with its manager." });

export const CallState = z.enum(["pending", "done", "failed", "withdrawn"]);

export const Output = z
  .strictObject({
    value: z
      .unknown()
      .describe("The structured value, checked against the output schema; null without one."),
    parts: z
      .array(z.looseObject({}))
      .describe("The rest of the result, such as text, as the called actor gave it."),
  })
  .meta({ id: "Output", description: "What a call returned." });

export const Call = z
  .strictObject({
    id: Id,
    from: Id.describe("The calling actor."),
    to: Id.describe("The called actor."),
    interface: z.string().describe("The called actor's own name for the interface."),
    input: z.record(z.string(), z.unknown()),
    state: CallState,
    output: Output.nullable().describe("The result, once done."),
    error: z.string().nullable().describe("Why it failed, once failed."),
    cause: Id.nullable().describe("The call that led to this one."),
    run: z
      .string()
      .nullable()
      .describe("The called actor's handle for the call while it runs long."),
    created_at: Timestamp,
    delivered_at: Timestamp.nullable().describe("When the called actor last received it."),
    settled_at: Timestamp.nullable(),
  })
  .meta({ id: "Call", description: "One call from an actor into another." });

export const AuditEntry = z
  .strictObject({
    id: z.number().int(),
    at: Timestamp,
    actor: Id.nullable().describe("The acting actor."),
    operation: z
      .string()
      .describe("A built-in's name, or call for a routed call, created and settled."),
    target: Id.nullable().describe("The record it acted on."),
    outcome: z
      .string()
      .describe('"ok" or the error code, or for a call the state it entered or the refusal.'),
  })
  .meta({ id: "AuditEntry" });

/** Durable identity and lifecycle; connection state is owned separately. */
export const ActorRecord = Actor.omit({ path: true, online: true, interfaces: true }).extend({
  credential_hash: z.string(),
});

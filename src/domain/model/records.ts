/** Actor identities, Hub interface schemas and audit entries. */

import { z } from "zod";

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
  .describe("A short handle, unique among its siblings, that names the Actor in the organization.");

/** The local name of a Hub Tool interface. */
export const INTERFACE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const JsonSchema = z.record(z.string(), z.unknown()).describe("A JSON Schema.");

export const Interface = z
  .strictObject({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    input: JsonSchema.describe("The JSON Schema its input must match."),
    output: JsonSchema.optional().describe(
      "The JSON Schema of its structured result, when declared.",
    ),
    one_way: z.boolean().describe("Its caller does not wait for its result."),
    long_running: z.boolean().describe("The operation may take an extended time to complete."),
  })
  .meta({ id: "Interface", description: "An interface exposed by a Hub Tool." });

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
    online: z.boolean().describe("True while the Actor has an admitted Hub connection."),
    created_at: Timestamp,
    closed_at: Timestamp.nullable(),
  })
  .meta({ id: "Actor", description: "A position in the organization, with its manager." });

export const AuditEntry = z
  .strictObject({
    id: z.number().int(),
    at: Timestamp,
    actor: Id.nullable().describe("The acting actor."),
    operation: z
      .string()
      .describe("A Hub operation's name, or call for an interface refusal or historical call."),
    target: Id.nullable().describe("The record it acted on."),
    outcome: z
      .string()
      .describe('"ok" or the error code, or for a call the state it entered or the refusal.'),
  })
  .meta({ id: "AuditEntry" });

/** Durable identity and lifecycle; connection state is owned separately. */
export const ActorRecord = Actor.omit({ path: true, online: true }).extend({
  credential_hash: z.string(),
});

/**
 * The core's built-ins, the surface every actor finds among its available interfaces: their
 * requests, results and descriptions. Workspace modules own their interaction contracts.
 * Every open Actor receives the same built-in interfaces; each operation enforces its authority.
 */

import { z } from "zod";
import { ATTENTION } from "./attention.ts";
import { CLAIMS } from "./claims.ts";
import { toolDefinition } from "./json-schema.ts";
import { Actor, AuditEntry, Handle, Id, Text } from "./records.ts";
import { SYSTEM } from "./system.ts";
import { TEAM } from "./team.ts";
import { DIRECTORY, FORMS, MESSAGES, STATUS, WORK } from "./workspace.ts";

export const ExecutionOptions = z.strictObject({
  providerId: Id.describe("The enrolled Provider to ask for execution."),
  config: z
    .record(z.string(), z.json())
    .describe(
      "A required JSON object following the Provider's configuration schema; use {} when empty.",
    ),
});

export const ExecutionResult = z.strictObject({
  providerId: Id,
  status: z
    .enum(["ready", "failed", "unknown"])
    .describe("The Provider creation outcome, independent of Actor connectivity."),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});

export const ActorCreate = z
  .strictObject({
    name: Handle,
    purpose: Text.describe("What the actor is for, for a reader outside it."),
    execution: ExecutionOptions.optional().describe(
      "Optionally arrange execution through a Provider after creating the Actor.",
    ),
  })
  .meta({ id: "ActorCreate" });

export const ActorCreated = z
  .strictObject({
    actor: Actor,
    execution: ExecutionResult.optional(),
    credential: z
      .string()
      .describe(
        "The new actor's credential, shown only this once: it connects to the core with it.",
      ),
  })
  .meta({ id: "ActorCreated" });

export const ActorClose = z.strictObject({ actor: Id }).meta({ id: "ActorClose" });

export const ActorClosed = z
  .strictObject({
    actor: Actor,
  })
  .meta({ id: "ActorClosed" });

export const Activity = z
  .strictObject({
    since: z.number().int().optional().describe("After this entry id; without it, the latest."),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .meta({ id: "Activity" });

export const ActivityResult = z
  .strictObject({ entries: z.array(AuditEntry).describe("Oldest first.") })
  .meta({ id: "ActivityResult" });

export const ACTORS = toolDefinition("actors", {
  actor_create: {
    writes: true,
    level: "organization",
    request: ActorCreate,
    response: ActorCreated,
    description: `Create a direct report: a position that you manage.

Returns the actor and its credential, shown only this once. Whatever fills the position connects to the core with it.

With execution, wait for the Provider and return its separate ready, failed or unknown outcome. The Actor remains created for every execution outcome. Ready confirms Provider creation, independently of Actor connectivity.`,
  },
  actor_close: {
    writes: true,
    level: "organization",
    request: ActorClose,
    response: ActorClosed,
    description: `Close a direct report whose work is done; the root may close any actor.

Refused while it has open reports of its own. Its Hub connections close.`,
  },
});

export const ACTIVITY = toolDefinition("activity", {
  activity: {
    writes: false,
    level: "organization",
    request: Activity,
    response: ActivityResult,
    description: "Read the organization's audit metadata, oldest first. Only the root may.",
  },
});

/** Derived schemas for CLI and typed callers; feature modules supply runtime operations. */
export const BUILTINS = {
  ...ACTORS.interfaces,
  ...TEAM.interfaces,
  ...CLAIMS.interfaces,
  ...DIRECTORY.interfaces,
  ...MESSAGES.interfaces,
  ...WORK.interfaces,
  ...FORMS.interfaces,
  ...STATUS.interfaces,
  ...ATTENTION.interfaces,
  ...ACTIVITY.interfaces,
  ...SYSTEM.interfaces,
} as const;

export type BuiltinName = keyof typeof BUILTINS;
export type RequestOf<N extends BuiltinName> = z.output<(typeof BUILTINS)[N]["request"]>;
export type ResponseOf<N extends BuiltinName> = z.output<(typeof BUILTINS)[N]["response"]>;

export const BUILTIN_NAMES = Object.keys(BUILTINS) as BuiltinName[];

/**
 * The core's built-ins, the surface every actor finds among its available interfaces: their
 * requests, results and descriptions. The communication standard's are in `communication.ts`.
 * `activity` is offered to the root only.
 */

import { z } from "zod";
import { COMMUNICATION } from "./communication.ts";
import type { BuiltinSpec } from "./json-schema.ts";
import { Actor, AuditEntry, Call, Handle, Id, MAX_WAIT_SECONDS, Text } from "./records.ts";

/**
 * A handle that begins a built-in's name. Clients such as Claude Code and Codex turn the dot of a
 * routed name into `_`, so a report named `call` would offer `call_result` beside the built-in.
 */
const reserved = (handle: string): boolean =>
  Object.keys(BUILTINS).some((name: string) => name.startsWith(`${handle}_`));

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
    name: Handle.refine((handle) => !reserved(handle), "begins a built-in's name, as call does"),
    purpose: Text.describe("What the actor is for, for a reader outside it."),
    execution: ExecutionOptions.optional().describe(
      "Optionally arrange execution through a Provider after creating the Actor.",
    ),
    created_at_attach: z
      .boolean()
      .default(false)
      .describe(
        "For the root only: the position is created as a session the user started attaches to it.",
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
    ended_calls: z
      .array(Call)
      .describe("Its pending calls: those it made are withdrawn, and those into it failed."),
  })
  .meta({ id: "ActorClosed" });

export const CallResult = z
  .strictObject({
    call: Id.describe("A call you made."),
    wait: z
      .number()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .default(0)
      .describe("Seconds to wait for it to settle, with progress notifications."),
  })
  .meta({ id: "CallResult" });

export const CallWithdraw = z.strictObject({ call: Id }).meta({ id: "CallWithdraw" });

export const Activity = z
  .strictObject({
    since: z.number().int().optional().describe("Only entries after this entry id."),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .meta({ id: "Activity" });

export const ActivityResult = z
  .strictObject({ entries: z.array(AuditEntry).describe("Newest first.") })
  .meta({ id: "ActivityResult" });

export const BUILTINS = {
  actor_create: {
    tool: "actors",
    writes: true,
    rootOnly: false,
    request: ActorCreate,
    response: ActorCreated,
    description: `Create a direct report: a position that you manage.

Returns the actor and its credential, shown only this once. Whatever fills the position connects to the core with it.

With execution, wait for the Provider and return its separate ready, failed or unknown outcome. The Actor remains created for every execution outcome. Ready confirms Provider creation, independently of Actor connectivity.`,
  },
  actor_close: {
    tool: "actors",
    writes: true,
    rootOnly: false,
    request: ActorClose,
    response: ActorClosed,
    description: `Close a direct report whose work is done; the root may close any actor.

Refused while it has open reports of its own. Its pending calls end and its connections close.`,
  },
  ...COMMUNICATION,
  call_result: {
    tool: "calls",
    writes: false,
    rootOnly: false,
    request: CallResult,
    response: Call,
    description: `Read a call you made, with its output once done.

With wait, hold until it settles or the wait ends, whichever is first.`,
  },
  call_withdraw: {
    tool: "calls",
    writes: true,
    rootOnly: false,
    request: CallWithdraw,
    response: Call,
    description: "Withdraw a pending call you made that no longer needs an answer.",
  },
  activity: {
    tool: "activity",
    writes: false,
    rootOnly: true,
    request: Activity,
    response: ActivityResult,
    description: "Read the audit trail: every write and every routed call, newest first.",
  },
} as const satisfies Record<string, BuiltinSpec>;

export type BuiltinName = keyof typeof BUILTINS;
export type RequestOf<N extends BuiltinName> = z.output<(typeof BUILTINS)[N]["request"]>;
export type ResponseOf<N extends BuiltinName> = z.output<(typeof BUILTINS)[N]["response"]>;

export const BUILTIN_NAMES = Object.keys(BUILTINS) as BuiltinName[];

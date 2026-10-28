/**
 * The core's built-in tools, the management surface every actor finds in its `/mcp` tool list:
 * their requests, results and descriptions. `activity` is listed to the root only.
 */

import { z } from "zod";
import { Actor, AuditEntry, Call, Handle, Id, LIMITS, StatusState, Text } from "./records.ts";

/** The longest `call_result` wait, in seconds. */
export const MAX_WAIT_SECONDS = 600;

export const ActorCreate = z
  .strictObject({
    name: Handle,
    purpose: Text.describe("What the actor is for, for a reader outside it."),
  })
  .meta({ id: "ActorCreate" });

export const ActorCreated = z
  .strictObject({
    actor: Actor,
    credential: z
      .string()
      .describe(
        "The new actor's credential, shown only this once: it dials both endpoints with it.",
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

export const StatusSet = z
  .strictObject({
    state: StatusState,
    summary: z
      .string()
      .trim()
      .max(LIMITS.summary)
      .default("")
      .describe("Plain text, never a log; line breaks are kept."),
  })
  .meta({ id: "StatusSet" });

export const ViewRequest = z
  .strictObject({
    actor: Id.optional().describe(
      "A direct report to view; the root may view anyone. Default: you.",
    ),
  })
  .meta({ id: "ViewRequest" });

export const HISTORY_MAX = 50;

export const View = z
  .strictObject({
    actor: Actor,
    manager: Actor.nullable().describe("Null for the root."),
    reports: z.array(Actor).describe("Its direct reports that are not closed, with their status."),
    pending: z.array(Call).describe("Pending calls into it, oldest first."),
    open_calls: z.array(Call).describe("Its own pending calls, oldest first."),
    history: z
      .array(Call)
      .describe(`Settled calls into it and from it, newest first, at most ${HISTORY_MAX}.`),
    names: z
      .record(z.string(), z.string())
      .describe("The path of each actor the calls name, by id; for the root, its name."),
  })
  .meta({ id: "View", description: "What an actor sees of its own position." });

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

export interface BuiltinSpec {
  /** Writes are recorded in the audit trail. */
  readonly writes: boolean;
  readonly rootOnly: boolean;
  readonly request: z.ZodType;
  readonly response: z.ZodType;
  /** The first paragraph is the summary. */
  readonly description: string;
}

export const BUILTINS = {
  actor_create: {
    writes: true,
    rootOnly: false,
    request: ActorCreate,
    response: ActorCreated,
    description: `Create a direct report: a position that you manage.

Returns the actor and its credential, shown only this once. Whatever fills the position dials both of the core's endpoints with it.`,
  },
  actor_close: {
    writes: true,
    rootOnly: false,
    request: ActorClose,
    response: ActorClosed,
    description: `Close a direct report whose work is done; the root may close any actor.

Refused while it has open reports of its own. Its pending calls end and its connections close.`,
  },
  status_set: {
    writes: true,
    rootOnly: false,
    request: StatusSet,
    response: Actor,
    description: `Set your own status: running, waiting, blocked or review, with a short plain-text summary.

Your manager sees it in its view. It is a status, not a log.`,
  },
  view: {
    writes: false,
    rootOnly: false,
    request: ViewRequest,
    response: View,
    description: `See your position, or a direct report's: what is pending on it and from whom, its own open calls, its reports with their status, its manager, and recent calls.

The root may view any actor.`,
  },
  call_result: {
    writes: false,
    rootOnly: false,
    request: CallResult,
    response: Call,
    description: `Read a call you made, with its output once done.

With wait, hold until it settles or the wait ends, whichever is first.`,
  },
  call_withdraw: {
    writes: true,
    rootOnly: false,
    request: CallWithdraw,
    response: Call,
    description: "Withdraw a pending call you made that no longer needs an answer.",
  },
  activity: {
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

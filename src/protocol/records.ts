/** The records the core keeps and returns: actors, calls and the audit trail. */

import { z } from "zod";
import { MANAGER } from "./endpoints.ts";

/** Size caps. The core refuses longer text, which keeps logs out of the record. */
export const LIMITS = { id: 64, text: 1000, summary: 2000 } as const;

const text = (max: number) => z.string().trim().min(1).max(max);

export const Id = text(LIMITS.id);
export const Text = text(LIMITS.text);
export const Timestamp = z.iso.datetime({ offset: true });

export const Handle = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a lowercase handle such as storage or web-ui")
  .refine((handle) => handle !== MANAGER, `${MANAGER} names an actor's manager`)
  .describe("A short handle, unique among its siblings, that names the actor in tool names.");

export const StatusState = z.enum(["running", "waiting", "blocked", "review"]);

export const Status = z
  .strictObject({
    state: StatusState,
    summary: z.string().trim().max(LIMITS.summary).describe("Plain text; line breaks are kept."),
    updated_at: Timestamp,
  })
  .meta({ id: "Status", description: "The actor's status, set by the actor itself." });

/** An MCP `Tool` object, as the actor listed it. */
export const ToolObject = z
  .looseObject({ name: z.string(), inputSchema: z.looseObject({}) })
  .meta({ id: "Tool", description: "An MCP Tool object, as the actor's tools/list gave it." });

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
    online: z.boolean().describe("True while the actor's reverse connection is open."),
    tools: z.array(ToolObject).describe("Its exposed tools, as it last listed them."),
    status: Status.nullable(),
    created_at: Timestamp,
    closed_at: Timestamp.nullable(),
  })
  .meta({ id: "Actor", description: "A position in the organization, with its manager." });

export const CallState = z.enum(["pending", "done", "failed", "withdrawn"]);

/** An MCP `CallToolResult`, as the called actor returned it. */
export const ToolResult = z
  .looseObject({ content: z.array(z.looseObject({})) })
  .meta({ id: "ToolResult", description: "An MCP CallToolResult, as the called actor gave it." });

export const Call = z
  .strictObject({
    id: Id,
    from: Id.describe("The calling actor."),
    to: Id.describe("The called actor."),
    tool: z.string().describe("The called actor's own name for the tool."),
    input: z.record(z.string(), z.unknown()),
    state: CallState,
    output: ToolResult.nullable().describe("The result, once done."),
    error: z.string().nullable().describe("Why it failed, once failed."),
    cause: Id.nullable().describe("The call that led to this one."),
    task: z
      .string()
      .nullable()
      .describe("The MCP task the called actor runs it as, when it took the call as a task."),
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
      .describe("A built-in tool's name, or call for a routed call, created and settled."),
    target: Id.nullable().describe("The record it acted on."),
    outcome: z
      .string()
      .describe('"ok" or the error code, or for a call the state it entered or the refusal.'),
  })
  .meta({ id: "AuditEntry" });

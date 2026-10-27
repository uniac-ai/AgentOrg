/** The audit trail: every write, with who made it and through which surface. */

import { z } from "zod";
import { Id, Short, Timestamp } from "./common.ts";

export const Channel = z.enum(["mcp", "api", "page"]);

export const AuditEntry = z
  .strictObject({
    id: z.number().int(),
    at: Timestamp,
    session: Id.nullable().describe("The acting session, when the request names one."),
    agent: Id.nullable().describe("The acting session's agent."),
    client: Short.nullable(),
    operation: Short,
    target: Id.nullable().describe("The record the operation acted on."),
    channel: Channel,
    outcome: Short.describe('"ok", or the error code the operation returned.'),
  })
  .meta({ id: "AuditEntry" });

export const AuditList = z
  .strictObject({
    session: Id.optional(),
    agent: Id.optional(),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .meta({ id: "AuditList" });

export const AuditListResult = z
  .strictObject({ entries: z.array(AuditEntry).describe("Newest first.") })
  .meta({ id: "AuditListResult" });

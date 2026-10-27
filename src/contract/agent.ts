/** Agents: the organization. An agent is a work responsibility with a manager. */

import { z } from "zod";
import { Id, LIMITS, Link, Short, Text, Timestamp, Title } from "./common.ts";

export const AgentState = z.enum(["pending", "active", "closed"]);
export const StatusState = z.enum(["running", "waiting", "blocked", "review"]);
const Summary = z.string().trim().max(LIMITS.summary);

export const Status = z
  .strictObject({
    state: StatusState,
    summary: Summary.describe("Plain text; line breaks are kept."),
    links: z.array(Link),
    blockers: z.array(Short).describe("Who unblocks the agent."),
    updated_at: Timestamp,
  })
  .meta({ id: "Status", description: "The agent's status, set by its attached session." });

export const Agent = z
  .strictObject({
    id: Id.describe("Issued by the service."),
    title: Title,
    purpose: Text,
    manager: Id.nullable().describe("The managing agent; null when the user is the manager."),
    created_by: Id.nullable().describe("The session that created it; null when the user did."),
    created_at_attach: z
      .boolean()
      .describe(
        "True when a session created it directly under the user as it attached, on the user's appointment in words.",
      ),
    state: AgentState.describe("Pending until a session first attaches, then active, then closed."),
    status: Status.nullable(),
    created_at: Timestamp,
    closed_at: Timestamp.nullable(),
  })
  .meta({ id: "Agent" });

export const AgentCreate = z
  .strictObject({
    session: Id.optional().describe(
      "The acting session; the new agent is a child of its agent. Omit when the user creates it.",
    ),
    title: Title.describe('The responsibility, such as "Migrate session storage".'),
    purpose: Text.describe("What the agent is for, for a reader outside the session."),
  })
  .meta({ id: "AgentCreate" });

export const AgentClose = z
  .strictObject({
    session: Id.optional().describe("The manager's acting session. Omit when the user closes it."),
    agent: Id,
  })
  .meta({ id: "AgentClose" });

export const StatusSet = z
  .strictObject({
    session: Id,
    state: StatusState,
    summary: Summary.default("").describe("Plain text, never a log; line breaks are kept."),
    links: z.array(Link).max(20).default([]),
    blockers: z.array(Short).max(10).default([]),
  })
  .meta({ id: "StatusSet" });

export const AgentList = z
  .strictObject({ include_closed: z.boolean().default(false) })
  .meta({ id: "AgentList" });

export const AgentGet = z.strictObject({ agent: Id }).meta({ id: "AgentGet" });

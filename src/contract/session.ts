/** Sessions: conversations in a client that attach to an agent and act for it. */

import { z } from "zod";
import { ClientKind, Id, Short, Text, Timestamp, Title } from "./common.ts";

export const Session = z
  .strictObject({
    id: Id.describe("Issued by the service; writes name it as `session`."),
    agent: Id,
    client: ClientKind.describe('The client kind, such as "claude-code" or "codex".'),
    client_session_id: Short.nullable().describe("The client's own id for the conversation."),
    machine: Short,
    attached_at: Timestamp,
    detached_at: Timestamp.nullable().describe("Set when another session attached to the agent."),
  })
  .meta({ id: "Session" });

export const NewAgent = z
  .strictObject({ title: Title, purpose: Text })
  .meta({ id: "NewAgent", description: "An agent to create directly under the user." });

export const SessionAttach = z
  .strictObject({
    agent: Id.optional().describe("The agent to act for, from the brief its manager wrote."),
    new_agent: NewAgent.optional().describe(
      "Instead of agent: create an agent directly under the user and attach to it, when the user started this session with an appointment in words. Allowed only on the client session's first attach.",
    ),
    client: ClientKind.optional().describe("Defaults to the client the transport names."),
    client_session_id: Short.optional().describe("Defaults to the one the transport carries."),
    machine: Short.optional().describe("Defaults to the service's host name."),
  })
  .refine(
    (attach) => (attach.agent === undefined) !== (attach.new_agent === undefined),
    "name either agent or new_agent",
  )
  .meta({ id: "SessionAttach" });

export const SessionContext = z
  .strictObject({
    client: ClientKind.optional().describe("Defaults to the client the transport names."),
    client_session_id: Short.optional().describe("Defaults to the one the transport carries."),
  })
  .meta({ id: "SessionContext" });

/** Results that bring together records of several subjects for one reader. */

import { z } from "zod";
import { Agent, StatusEntry } from "./agent.ts";
import { Ask } from "./ask.ts";
import { ClientKind, Id, Timestamp } from "./common.ts";
import { Message } from "./message.ts";
import { Session } from "./session.ts";

export const Facts = z
  .strictObject({
    session: Session,
    agent: Agent,
    manager: Agent.nullable().describe("Null when the user is the manager."),
    children: z
      .array(Agent)
      .describe("The agent's children that are not closed, with their status."),
    asks_to_answer: z.array(Ask).describe("Open asks addressed to the agent."),
    own_asks: z.array(Ask).describe("The agent's own asks that are open or answered."),
    inbox: z.array(Message).describe("Unread messages, and reports not yet acknowledged."),
  })
  .meta({
    id: "Facts",
    description: "What a session acts on, facts only: the skill decides how to act on them.",
  });

export const STATUS_HISTORY_MAX = 100;

export const SessionContextResult = z
  .strictObject({
    facts: Facts.nullable().describe(
      "Null when no session with this client session id is attached.",
    ),
  })
  .meta({ id: "SessionContextResult" });

export const AgentCloseResult = z
  .strictObject({
    agent: Agent,
    withdrawn_asks: z.array(Ask).describe("The open asks closing withdrew."),
    detached_sessions: z
      .array(Session)
      .describe("The session closing detached, if one was attached."),
  })
  .meta({ id: "AgentCloseResult", description: "The cleanup list for the manager." });

export const AttachedSession = z
  .strictObject({ id: Id, client: ClientKind, attached_at: Timestamp })
  .meta({ id: "AttachedSession", description: "The session attached to an agent now." });

export const AgentSummary = z
  .strictObject({
    agent: Agent,
    asks_to_answer: z.number().int().describe("Open asks addressed to the agent."),
    unread_messages: z.number().int().describe("Unread messages addressed to the agent."),
    attached_session: AttachedSession.nullable().describe("Null when no session is attached."),
    last_activity_at: Timestamp.describe(
      "The latest write any of the agent's sessions made, or the agent's creation when there is none.",
    ),
  })
  .meta({ id: "AgentSummary" });

export const AgentListResult = z
  .strictObject({
    agents: z.array(AgentSummary).describe("Oldest first; managers before children."),
  })
  .meta({ id: "AgentListResult" });

export const AgentDetail = z
  .strictObject({
    agent: Agent,
    own_asks: z.array(Ask).describe("Every ask the agent opened, with the manager each went to."),
    addressed_asks: z.array(Ask).describe("Every ask addressed to the agent."),
    messages: z.array(Message).describe("Messages from the agent and to it."),
    sessions: z.array(Session).describe("Every session that attached to it, newest first."),
    status_history: z
      .array(StatusEntry)
      .describe(`The statuses its sessions set, newest first, at most ${STATUS_HISTORY_MAX}.`),
  })
  .meta({ id: "AgentDetail", description: "One agent in full; reading it marks nothing read." });

export const AskListResult = z
  .strictObject({
    asks: z.array(Ask),
    agents: z
      .array(Agent)
      .describe("The agents the asks come from and go to, for building escalation chains."),
  })
  .meta({ id: "AskListResult" });

export const ViewAsUser = z
  .strictObject({
    agent: Id.nullable().describe("The agent to view; null views the user."),
  })
  .meta({ id: "ViewAsUser" });

export const View = z
  .strictObject({
    agent: Agent.nullable().describe("The agent viewed; null when it is the user."),
    manager: Agent.nullable().describe("Its manager; null for the user and agents under the user."),
    children: z.array(Agent).describe("Its direct reports that are not closed, with their status."),
    asks_to_answer: z.array(Ask).describe("Open asks addressed to it."),
    own_asks: z.array(Ask).describe("Its own asks that are open or answered; none for the user."),
    inbox: z.array(Message).describe("Unread messages, and reports not yet acknowledged, to it."),
    history: z
      .strictObject({
        asks: z.array(Ask).describe("Every ask it opened or was sent, in any state."),
        messages: z.array(Message).describe("Every message from it or to it."),
        sessions: z.array(Session).describe("Every session that attached to it, newest first."),
        status_history: z
          .array(StatusEntry)
          .describe("The statuses its sessions set, newest first."),
      })
      .describe("What happened to it, for its feed."),
  })
  .meta({
    id: "View",
    description:
      "What an entity sees, the user or an agent: the same facts session_attach gives an agent, and its history.",
  });

/**
 * Every operation of the contract, in order. The API, MCP and the CLI derive their routes, tools
 * and commands from this table, each serving the operations whose kind is meant for it:
 *
 * - `agent`: an MCP tool, and on the API and the CLI.
 * - `api`: on the API and the CLI only, for scripts, the page and the user's terminal.
 * - `user`: only to a signed-in page session, through the service layer; never on the API, MCP or
 *   the CLI, so the agents' bearer token cannot reach it.
 *
 * An operation's name, such as `ask_open`, is the MCP tool name and the OpenAPI operation id; the
 * API serves it at `POST /api/ask/open` and the CLI as `agentorg ask open`. Writes name the acting
 * session in the request, and the service resolves its agent.
 */

import type { z } from "zod";
import {
  Agent,
  AgentClose,
  AgentCloseAsUser,
  AgentCreate,
  AgentGet,
  AgentList,
  StatusSet,
} from "./agent.ts";
import {
  Ask,
  AskAnswer,
  AskAnswerAsUser,
  AskGet,
  AskList,
  AskOpen,
  AskRecordAnswer,
  AskWait,
  AskWithdraw,
} from "./ask.ts";
import { AuditList, AuditListResult } from "./audit.ts";
import {
  Inbox,
  InboxRead,
  Message,
  MessageAck,
  MessageAckAsUser,
  MessageReadAsUser,
  MessageSend,
} from "./message.ts";
import {
  AgentCloseResult,
  AgentDetail,
  AgentListResult,
  AskListResult,
  Facts,
  SessionContextResult,
} from "./results.ts";
import { SessionAttach, SessionContext } from "./session.ts";
import { LoginLink, LoginLinkCreate } from "./ui.ts";

export type Kind = "agent" | "api" | "user";

export interface OperationSpec {
  readonly kind: Kind;
  /** Writes are recorded in the audit log. */
  readonly writes: boolean;
  readonly request: z.ZodType;
  readonly response: z.ZodType;
  /** The first paragraph is the summary. */
  readonly description: string;
}

export const OPERATIONS = {
  agent_create: {
    kind: "agent",
    writes: true,
    request: AgentCreate,
    response: Agent,
    description: `Create an agent: a work responsibility managed by the acting session's agent.

Returns the new agent; put its id in the brief of the session that will attach to it. Agents directly under the user come only from new_agent at attach.`,
  },
  agent_close: {
    kind: "agent",
    writes: true,
    request: AgentClose,
    response: AgentCloseResult,
    description: `Close a child agent whose work is done, and return the cleanup list.

Closing detaches its session and withdraws its open asks. Only its manager's sessions close it, once its own children are closed.`,
  },
  agent_close_as_user: {
    kind: "user",
    writes: true,
    request: AgentCloseAsUser,
    response: AgentCloseResult,
    description:
      "Close any agent as the user, once its own children are closed, and return the cleanup list.",
  },
  agent_list: {
    kind: "api",
    writes: false,
    request: AgentList,
    response: AgentListResult,
    description:
      "List the agent tree, each agent with its status and what waits on it: open asks addressed to it and unread messages to it.",
  },
  agent_get: {
    kind: "api",
    writes: false,
    request: AgentGet,
    response: AgentDetail,
    description:
      "Read one agent with its sessions, the asks it opened and the asks addressed to it, and its messages. It marks nothing read.",
  },
  session_attach: {
    kind: "agent",
    writes: true,
    request: SessionAttach,
    response: Facts,
    description: `Attach this session to an agent and return the facts it acts on.

Call it first, with the agent id from your brief. When the user started you with an appointment in words and no agent id, name new_agent instead, once. Attaching ends any earlier session of the agent. The facts are the agent, its manager, its children with their status, the open asks addressed to it, its own asks with any answers, and its inbox. Keep the session id it returns: every write names it as session.`,
  },
  session_context: {
    kind: "agent",
    writes: false,
    request: SessionContext,
    response: SessionContextResult,
    description: `Read the facts session_attach returns, for a client session already attached, without changing anything.

The facts are null when no session with that client session id is attached.`,
  },
  status_set: {
    kind: "agent",
    writes: true,
    request: StatusSet,
    response: Agent,
    description: `Set the status of the session's agent: its state, a short plain-text summary, links and blockers.

Its manager and the user see it. It is a status, not a log.`,
  },
  ask_open: {
    kind: "agent",
    writes: true,
    request: AskOpen,
    response: Ask,
    description: `Ask the agent's manager a question. It is addressed to the manager automatically; when the manager is the user, it appears on the decisions page.

Give context for a reader outside the session, two to six options and the label you recommend. To carry a child's ask up, list it in escalates. Then keep working and read the answer with ask_get or your next session_attach, or wait with ask_wait when you cannot go on without it.`,
  },
  ask_get: {
    kind: "agent",
    writes: false,
    request: AskGet,
    response: Ask,
    description: "Read an ask, with its answer once it has one.",
  },
  ask_wait: {
    kind: "agent",
    writes: false,
    request: AskWait,
    response: Ask,
    description: `Wait until an ask is answered or withdrawn and return it.

With a timeout, return the ask after that long even if it is still open.`,
  },
  ask_withdraw: {
    kind: "agent",
    writes: true,
    request: AskWithdraw,
    response: Ask,
    description:
      "Withdraw an open ask that no longer needs an answer. Only the asking agent's sessions may.",
  },
  ask_answer: {
    kind: "agent",
    writes: true,
    request: AskAnswer,
    response: Ask,
    description: `Answer an open ask addressed to the session's agent, with a choice, words, or both.

Answer it yourself when you can. When only your manager can, escalate it: open your own ask with the child's ask in escalates, and answer the child once you have the answer.`,
  },
  ask_record_answer: {
    kind: "agent",
    writes: true,
    request: AskRecordAnswer,
    response: Ask,
    description:
      "Record an answer the user gave in the asking session's own conversation, for an ask addressed to the user. Quote the user's words exactly.",
  },
  ask_answer_as_user: {
    kind: "user",
    writes: true,
    request: AskAnswerAsUser,
    response: Ask,
    description:
      "Answer any open ask as the user: one addressed to the user, or one the user steps in on.",
  },
  ask_list: {
    kind: "api",
    writes: false,
    request: AskList,
    response: AskListResult,
    description:
      "List every ask in a state, oldest first, whoever it is addressed to, with the agents it refers to.",
  },
  message_send: {
    kind: "agent",
    writes: true,
    request: MessageSend,
    response: Message,
    description:
      "Send a note or a report to the agent's manager. Messages only go up; the manager reads them when it chooses.",
  },
  inbox_read: {
    kind: "agent",
    writes: true,
    request: InboxRead,
    response: Inbox,
    description:
      "Read the agent's unread messages and the reports it has not acknowledged, and mark them read.",
  },
  message_ack: {
    kind: "agent",
    writes: true,
    request: MessageAck,
    response: Message,
    description: "Acknowledge a report to the agent after reviewing it. Only its recipient may.",
  },
  message_read_as_user: {
    kind: "user",
    writes: true,
    request: MessageReadAsUser,
    response: Message,
    description: "Mark a note to the user read.",
  },
  message_ack_as_user: {
    kind: "user",
    writes: true,
    request: MessageAckAsUser,
    response: Message,
    description: "Acknowledge a report to the user after reviewing it.",
  },
  audit_list: {
    kind: "api",
    writes: false,
    request: AuditList,
    response: AuditListResult,
    description: "List audit entries, newest first.",
  },
  ui_login_link: {
    kind: "api",
    writes: true,
    request: LoginLinkCreate,
    response: LoginLink,
    description: "Mint a one-time link that signs the browser in to the decisions page.",
  },
} as const satisfies Record<string, OperationSpec>;

export type OperationName = keyof typeof OPERATIONS;
export type RequestOf<N extends OperationName> = z.output<(typeof OPERATIONS)[N]["request"]>;
export type ResponseOf<N extends OperationName> = z.output<(typeof OPERATIONS)[N]["response"]>;

export const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[];

/** `ask_record_answer` is subject `ask` and verb `record_answer`. */
export function subjectAndVerb(name: OperationName): [string, string] {
  const split = name.indexOf("_");
  return [name.slice(0, split), name.slice(split + 1)];
}

export function summaryOf(name: OperationName): string {
  return OPERATIONS[name].description.split("\n\n")[0] ?? "";
}

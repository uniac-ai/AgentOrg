/**
 * The service layer over the SQLite store: the rules of the record, the audit log, and waits.
 *
 * A write names its acting session, and the service resolves the session's agent. It refuses the
 * write when the session is detached or the agent closed, so a stale session cannot act after
 * another attached or its manager closed the agent. Operations that move a record forward
 * (closing, reading, acknowledging) succeed again on a record already there; answering does not,
 * since a second answer would be a different decision.
 */

import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { z } from "zod";
import {
  type Agent,
  type Answer,
  type AnswerChannel,
  type Ask,
  ClientKind,
  type Message,
  OPERATION_NAMES,
  OPERATIONS,
  type OperationName,
  type PageSession,
  type RequestOf,
  type ResponseOf,
  type Session,
  Short,
  STATUS_HISTORY_MAX,
} from "../contract/index.ts";
import type { Store } from "../store/index.ts";
import {
  type Caller,
  Conflict,
  Forbidden,
  Invalid,
  invalid,
  NotFound,
  OperationError,
  type Service,
} from "./index.ts";

type AgentRecord = z.output<typeof Agent>;
type AskRecord = z.output<typeof Ask>;
type MessageRecord = z.output<typeof Message>;
type SessionRecord = z.output<typeof Session>;
type Op<N extends OperationName> = (
  request: RequestOf<N>,
  caller: Caller,
) => Promise<ResponseOf<N>>;
type Untyped = (request: object, caller: Caller) => Promise<unknown>;

export const LOGIN_LINK_LIFETIME_MS = 5 * 60 * 1000;
export const PAGE_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
const digest = (secret: string) => createHash("sha256").update(secret).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

/** The value a transport supplied, checked like the request field it stands in for. */
function fromTransport<T>(schema: z.ZodType<T>, value: string | undefined): T | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(parsed.error.issues);
  return parsed.data;
}

export class StoreService implements Service {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly machine: string;
  private readonly settled = new Map<string, { done: Promise<void>; settle: () => void }>();

  constructor(store: Store, options: { now?: () => Date; machine?: string } = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.machine = options.machine ?? hostname();
    // Every write is audited, driven by the contract's table so that no write can be left out.
    const writes = this as unknown as Record<OperationName, Untyped>;
    for (const name of OPERATION_NAMES.filter((each) => OPERATIONS[each].writes)) {
      const operation = writes[name];
      writes[name] = async (request, caller) => {
        try {
          const result = await operation(request, caller);
          this.audit(name, request, result, caller, "ok");
          return result;
        } catch (error) {
          if (error instanceof OperationError)
            this.audit(name, request, undefined, caller, error.code);
          throw error;
        }
      };
    }
  }

  private time(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  private found<T extends "agents" | "sessions" | "asks" | "messages">(table: T, id: string) {
    const record = this.store.get(table, id);
    if (!record) throw new NotFound(`there is no ${table.slice(0, -1)} ${id}`);
    return record;
  }

  /** The acting session and its agent, refused when the session is detached or the agent closed. */
  private actor(sessionId: string): { session: SessionRecord; agent: AgentRecord } {
    const session = this.found("sessions", sessionId);
    if (session.detached_at !== null) {
      throw new Conflict(
        `session ${session.id} is detached; another session attached to its agent`,
      );
    }
    const agent = this.found("agents", session.agent);
    if (agent.state === "closed") throw new Conflict(`agent ${agent.id} is closed`);
    return { session, agent };
  }

  // Agents

  agent_create: Op<"agent_create"> = async (request) => {
    const { session, agent: manager } = this.actor(request.session);
    const agent: AgentRecord = {
      id: newId("agt"),
      title: request.title,
      purpose: request.purpose,
      manager: manager.id,
      created_by: session.id,
      created_at_attach: false,
      state: "pending",
      status: null,
      created_at: this.time(),
      closed_at: null,
    };
    this.store.insert("agents", agent);
    return agent;
  };

  agent_close: Op<"agent_close"> = async (request) => {
    const { agent: manager } = this.actor(request.session);
    const target = this.found("agents", request.agent);
    if (target.manager !== manager.id) {
      throw new Forbidden(
        `only its manager, ${target.manager ?? "the user"}, closes agent ${target.id}`,
      );
    }
    return this.close(target);
  };

  agent_close_as_user: Op<"agent_close_as_user"> = async (request) =>
    this.close(this.found("agents", request.agent));

  /** Close an agent whose children are closed: withdraw its open asks and detach its session. */
  private close(target: AgentRecord): ResponseOf<"agent_close"> {
    if (target.state === "closed")
      return { agent: target, withdrawn_asks: [], detached_sessions: [] };
    const open = this.store.select("agents", "manager = ? AND state != 'closed'", [target.id]);
    if (open.length > 0) {
      const ids = open.map((child) => child.id).join(", ");
      throw new Conflict(`agent ${target.id} has open children (${ids}); close them first`);
    }
    return this.store.transaction(() => {
      const agent: AgentRecord = { ...target, state: "closed", closed_at: this.time() };
      this.store.update("agents", agent);
      const withdrawn = this.store
        .select("asks", "agent = ? AND state = 'open'", [agent.id])
        .map((ask) => this.settle({ ...ask, state: "withdrawn" }));
      const detached = this.store
        .select("sessions", "agent = ? AND detached_at IS NULL", [agent.id])
        .map((session) => this.detach(session));
      return { agent, withdrawn_asks: withdrawn, detached_sessions: detached };
    });
  }

  agent_list: Op<"agent_list"> = async (request) => {
    const agents = request.include_closed
      ? this.store.select("agents")
      : this.store.select("agents", "state != 'closed'");
    return {
      agents: agents.map((agent) => {
        const [attached] = this.store.select("sessions", "agent = ? AND detached_at IS NULL", [
          agent.id,
        ]);
        const [latest] = this.store.all(
          "SELECT max(at) AS at FROM audit WHERE agent = ? AND outcome = 'ok'",
          [agent.id],
        );
        return {
          agent,
          asks_to_answer: this.store.count("asks", `"to" = ? AND state = 'open'`, [agent.id]),
          unread_messages: this.store.count("messages", `"to" = ? AND read_at IS NULL`, [agent.id]),
          attached_session: attached
            ? { id: attached.id, client: attached.client, attached_at: attached.attached_at }
            : null,
          last_activity_at: typeof latest?.at === "string" ? latest.at : agent.created_at,
        };
      }),
    };
  };

  agent_get: Op<"agent_get"> = async (request) => {
    const agent = this.found("agents", request.agent);
    return {
      agent,
      own_asks: this.store.select("asks", "agent = ?", [agent.id]),
      addressed_asks: this.store.select("asks", `"to" = ?`, [agent.id]),
      messages: this.store.select("messages", `"from" = ? OR "to" = ?`, [agent.id, agent.id]),
      sessions: this.store.select("sessions", "agent = ?", [agent.id], "rowid DESC"),
      status_history: this.store.select(
        "status_history",
        "session IN (SELECT id FROM sessions WHERE agent = ?)",
        [agent.id],
        "rowid DESC",
        STATUS_HISTORY_MAX,
      ),
    };
  };

  // Sessions

  session_attach: Op<"session_attach"> = async (request, caller) => {
    const client = request.client ?? fromTransport(ClientKind, caller.client);
    if (client === undefined)
      throw new Invalid("name the client kind, such as claude-code or codex");
    const clientSessionId =
      request.client_session_id ?? fromTransport(Short, caller.clientSessionId) ?? null;
    return this.store.transaction(() => {
      const current = this.attachment(client, clientSessionId);
      const sessionId = newId("ses");
      let agent: AgentRecord;
      if (request.new_agent !== undefined) {
        if (clientSessionId === null) {
          throw new Invalid("new_agent needs a client session id, so that it is allowed only once");
        }
        const before = this.store.count("sessions", "client = ? AND client_session_id = ?", [
          client,
          clientSessionId,
        ]);
        if (before > 0) {
          throw new Conflict(
            "this client session attached before; new_agent is only for its first",
          );
        }
        agent = {
          id: newId("agt"),
          ...request.new_agent,
          manager: null,
          created_by: sessionId,
          created_at_attach: true,
          state: "pending",
          status: null,
          created_at: this.time(),
          closed_at: null,
        };
        this.store.insert("agents", agent);
      } else {
        agent = this.found("agents", request.agent as string);
        if (agent.state === "closed") throw new Conflict(`agent ${agent.id} is closed`);
        if (current?.agent === agent.id) return this.facts(current);
      }
      if (current) this.detach(current);
      for (const earlier of this.store.select("sessions", "agent = ? AND detached_at IS NULL", [
        agent.id,
      ])) {
        this.detach(earlier);
      }
      const session: SessionRecord = {
        id: sessionId,
        agent: agent.id,
        client,
        client_session_id: clientSessionId,
        machine: request.machine ?? this.machine,
        attached_at: this.time(),
        detached_at: null,
      };
      this.store.insert("sessions", session);
      this.store.update("agents", { ...agent, state: "active" });
      return this.facts(session);
    });
  };

  session_context: Op<"session_context"> = async (request, caller) => {
    const client = request.client ?? fromTransport(ClientKind, caller.client);
    const clientSessionId =
      request.client_session_id ?? fromTransport(Short, caller.clientSessionId);
    const session =
      client === undefined || clientSessionId === undefined
        ? undefined
        : this.attachment(client, clientSessionId);
    return { facts: session ? this.facts(session) : null };
  };

  private attachment(client: string, clientSessionId: string | null): SessionRecord | undefined {
    if (clientSessionId === null) return undefined;
    return this.store.select(
      "sessions",
      "client = ? AND client_session_id = ? AND detached_at IS NULL",
      [client, clientSessionId],
    )[0];
  }

  private detach(session: SessionRecord): SessionRecord {
    const detached = { ...session, detached_at: this.time() };
    this.store.update("sessions", detached);
    return detached;
  }

  private facts(session: SessionRecord): ResponseOf<"session_attach"> {
    const agent = this.found("agents", session.agent);
    return {
      session,
      agent,
      manager: agent.manager === null ? null : this.found("agents", agent.manager),
      children: this.store.select("agents", "manager = ? AND state != 'closed'", [agent.id]),
      asks_to_answer: this.store.select("asks", `"to" = ? AND state = 'open'`, [agent.id]),
      own_asks: this.store.select("asks", "agent = ? AND state != 'withdrawn'", [agent.id]),
      inbox: this.inbox(agent.id),
    };
  }

  // Status

  status_set: Op<"status_set"> = async (request) => {
    const { session, agent } = this.actor(request.session);
    const { state, summary, links, blockers } = request;
    const at = this.time();
    const updated: AgentRecord = {
      ...agent,
      status: { state, summary, links, blockers, updated_at: at },
    };
    this.store.transaction(() => {
      this.store.update("agents", updated);
      this.store.insert("status_history", {
        state,
        summary,
        links,
        blockers,
        at,
        session: session.id,
      });
    });
    return updated;
  };

  // Asks

  ask_open: Op<"ask_open"> = async (request) => {
    const { session, agent } = this.actor(request.session);
    for (const id of request.escalates) {
      const child = this.found("asks", id);
      if (child.to !== agent.id || child.state !== "open") {
        throw new Invalid(`ask ${id} is not an open ask addressed to agent ${agent.id}`);
      }
    }
    const ask: AskRecord = {
      id: newId("ask"),
      agent: agent.id,
      session: session.id,
      to: agent.manager,
      title: request.title,
      context: request.context,
      options: request.options,
      recommendation: request.recommendation,
      escalates: request.escalates,
      state: "open",
      answer: null,
      opened_at: this.time(),
    };
    this.store.insert("asks", ask);
    return ask;
  };

  ask_get: Op<"ask_get"> = async (request) => this.found("asks", request.ask);

  ask_wait: Op<"ask_wait"> = async (request) => {
    const ask = this.found("asks", request.ask);
    if (ask.state !== "open") return ask;
    let entry = this.settled.get(ask.id);
    if (!entry) {
      let settle = () => {};
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      entry = { done, settle };
      this.settled.set(ask.id, entry);
    }
    if (request.timeout_seconds === null) await entry.done;
    else {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, (request.timeout_seconds as number) * 1000);
      });
      await Promise.race([entry.done, timeout]);
      clearTimeout(timer);
    }
    return this.found("asks", request.ask);
  };

  ask_withdraw: Op<"ask_withdraw"> = async (request) => {
    const { agent } = this.actor(request.session);
    const ask = this.found("asks", request.ask);
    if (ask.agent !== agent.id) {
      throw new Forbidden(`only agent ${ask.agent}, which asked, withdraws ask ${ask.id}`);
    }
    if (ask.state !== "open") throw new Conflict(`ask ${ask.id} is already ${ask.state}`);
    return this.settle({ ...ask, state: "withdrawn" });
  };

  ask_answer: Op<"ask_answer"> = async (request) => {
    const { agent } = this.actor(request.session);
    const ask = this.found("asks", request.ask);
    if (ask.to !== agent.id) {
      throw new Forbidden(
        `only ${ask.to ?? "the user"}, which it is addressed to, answers ask ${ask.id}`,
      );
    }
    return this.answer(ask, request.choice, request.words, agent.id, "agent");
  };

  ask_record_answer: Op<"ask_record_answer"> = async (request) => {
    const { agent } = this.actor(request.session);
    const ask = this.found("asks", request.ask);
    if (ask.agent !== agent.id) {
      throw new Forbidden(
        `only agent ${ask.agent}, which asked, records the answer to ask ${ask.id}`,
      );
    }
    if (ask.to !== null) throw new Invalid(`ask ${ask.id} is addressed to ${ask.to}, not the user`);
    return this.answer(ask, request.choice, request.words, null, "session");
  };

  ask_answer_as_user: Op<"ask_answer_as_user"> = async (request) =>
    this.answer(this.found("asks", request.ask), request.choice, request.words, null, "page");

  private answer(
    ask: AskRecord,
    choice: string | undefined,
    words: string | undefined,
    by: string | null,
    channel: z.output<typeof AnswerChannel>,
  ): AskRecord {
    if (ask.state !== "open") throw new Conflict(`ask ${ask.id} is already ${ask.state}`);
    const labels = ask.options.map((option) => option.label);
    if (choice !== undefined && !labels.includes(choice)) {
      throw new Invalid(`the choice must be one of the options: ${labels.join(", ")}`);
    }
    const answer: z.output<typeof Answer> = {
      choice: choice ?? null,
      words: words ?? null,
      by,
      channel,
      answered_at: this.time(),
    };
    return this.settle({ ...ask, state: "answered", answer });
  }

  /** Store an ask that has left the open state, and wake whoever waits on it. */
  private settle(ask: AskRecord): AskRecord {
    this.store.update("asks", ask);
    this.settled.get(ask.id)?.settle();
    this.settled.delete(ask.id);
    return ask;
  }

  ask_list: Op<"ask_list"> = async (request) => {
    const asks =
      request.state === null
        ? this.store.select("asks")
        : this.store.select("asks", "state = ?", [request.state]);
    const ids = [...new Set(asks.flatMap((ask) => [ask.agent, ask.to]))].filter(
      (id): id is string => id !== null,
    );
    const agents = ids.length
      ? this.store.select("agents", `id IN (${ids.map(() => "?").join(", ")})`, ids)
      : [];
    return { asks, agents };
  };

  // Messages

  message_send: Op<"message_send"> = async (request) => {
    const { agent } = this.actor(request.session);
    const message: MessageRecord = {
      id: newId("msg"),
      from: agent.id,
      to: agent.manager,
      kind: request.kind,
      body: request.body,
      evidence: [],
      sent_at: this.time(),
      read_at: null,
      acknowledged_at: null,
    };
    this.store.insert("messages", message);
    return message;
  };

  inbox_read: Op<"inbox_read"> = async (request) => {
    const { agent } = this.actor(request.session);
    return {
      messages: this.inbox(agent.id).map((message) => {
        if (message.read_at !== null) return message;
        const read = { ...message, read_at: this.time() };
        this.store.update("messages", read);
        return read;
      }),
    };
  };

  /** Unread messages to the agent, and reports to it not yet acknowledged. */
  private inbox(agentId: string): MessageRecord[] {
    return this.store.select(
      "messages",
      `"to" = ? AND (read_at IS NULL OR (kind = 'report' AND acknowledged_at IS NULL))`,
      [agentId],
    );
  }

  message_ack: Op<"message_ack"> = async (request) => {
    const { agent } = this.actor(request.session);
    return this.acknowledge(this.found("messages", request.message), agent.id);
  };

  message_ack_as_user: Op<"message_ack_as_user"> = async (request) =>
    this.acknowledge(this.found("messages", request.message), null);

  message_read_as_user: Op<"message_read_as_user"> = async (request) => {
    const message = this.found("messages", request.message);
    if (message.to !== null) throw new Forbidden(`message ${message.id} is not to the user`);
    if (message.kind === "report") {
      throw new Invalid(`message ${message.id} is a report; acknowledge it instead`);
    }
    if (message.read_at !== null) return message;
    const read = { ...message, read_at: this.time() };
    this.store.update("messages", read);
    return read;
  };

  private acknowledge(message: MessageRecord, recipient: string | null): MessageRecord {
    if (message.to !== recipient) {
      throw new Forbidden(
        `only ${message.to ?? "the user"}, its recipient, acknowledges ${message.id}`,
      );
    }
    if (message.kind !== "report")
      throw new Invalid(`message ${message.id} is a note; only reports are acknowledged`);
    if (message.acknowledged_at !== null) return message;
    const at = this.time();
    const acknowledged = { ...message, read_at: message.read_at ?? at, acknowledged_at: at };
    this.store.update("messages", acknowledged);
    return acknowledged;
  }

  // Audit

  audit_list: Op<"audit_list"> = async (request) => {
    const conditions: string[] = [];
    const parameters: string[] = [];
    for (const field of ["session", "agent"] as const) {
      const value = request[field];
      if (value !== undefined) {
        conditions.push(`${field} = ?`);
        parameters.push(value);
      }
    }
    const where = conditions.join(" AND ") || "1";
    return { entries: this.store.select("audit", where, parameters, "id DESC", request.limit) };
  };

  /** Record one write: who made it, through which surface, on what, and how it ended. */
  private audit(
    name: OperationName,
    request: object,
    result: unknown,
    caller: Caller,
    outcome: string,
  ): void {
    const fields = request as Record<string, unknown>;
    const record = (result ?? {}) as Record<string, { id?: string } | string | undefined>;
    const sessionId =
      (fields.session as string | undefined) ??
      (name === "session_attach" ? (record.session as { id?: string } | undefined)?.id : undefined);
    const session = sessionId ? this.store.get("sessions", sessionId) : undefined;
    const target =
      (typeof record.id === "string" ? record.id : undefined) ??
      (record.agent as { id?: string } | undefined)?.id ??
      ["ask", "message", "agent"]
        .map((field) => fields[field])
        .find((id) => typeof id === "string");
    this.store.run(
      "INSERT INTO audit (at, session, agent, client, operation, target, channel, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        this.time(),
        sessionId ?? null,
        session?.agent ?? null,
        caller.client ?? session?.client ?? null,
        name,
        (target as string | undefined) ?? null,
        caller.channel,
        outcome,
      ],
    );
  }

  // Decisions page sign-in

  ui_login_link: Op<"ui_login_link"> = async () => {
    const token = secret();
    const expires_at = this.time(LOGIN_LINK_LIFETIME_MS);
    this.store.run("INSERT INTO login_tokens (token_hash, expires_at) VALUES (?, ?)", [
      digest(token),
      expires_at,
    ]);
    return { path: `/ui/login?token=${token}`, expires_at };
  };

  async redeemLoginToken(token: string): Promise<z.output<typeof PageSession>> {
    const [row] = this.store.all(
      "SELECT expires_at FROM login_tokens WHERE token_hash = ? AND used_at IS NULL",
      [digest(token)],
    );
    if (!row || String(row.expires_at) <= this.time()) {
      throw new Invalid("this sign-in link is unknown, used or expired; run agentorg ui again");
    }
    const page = {
      id: secret(),
      csrf_token: secret(),
      expires_at: this.time(PAGE_SESSION_LIFETIME_MS),
    };
    this.store.transaction(() => {
      this.store.run("UPDATE login_tokens SET used_at = ? WHERE token_hash = ?", [
        this.time(),
        digest(token),
      ]);
      this.store.run(
        "INSERT INTO page_sessions (id_hash, csrf_token, expires_at) VALUES (?, ?, ?)",
        [digest(page.id), page.csrf_token, page.expires_at],
      );
    });
    return page;
  }

  async getPageSession(id: string): Promise<z.output<typeof PageSession> | null> {
    const [row] = this.store.all(
      "SELECT csrf_token, expires_at FROM page_sessions WHERE id_hash = ?",
      [digest(id)],
    );
    if (!row || String(row.expires_at) <= this.time()) return null;
    return { id, csrf_token: String(row.csrf_token), expires_at: String(row.expires_at) };
  }
}

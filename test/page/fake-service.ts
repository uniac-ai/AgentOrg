/** The service layer as the decisions page uses it, in memory, recording each user operation. */

import type { Hono } from "hono";
import type { z } from "zod";
import { createApp } from "../../src/app.ts";
import type {
  Agent,
  Ask,
  Message,
  PageSession,
  Session,
  Status,
} from "../../src/contract/index.ts";
import type { AppEnv } from "../../src/http.ts";
import {
  type Caller,
  Conflict,
  Invalid,
  NotFound,
  type Service,
} from "../../src/operations/index.ts";

type AgentRecord = z.output<typeof Agent>;
type AskRecord = z.output<typeof Ask>;
type MessageRecord = z.output<typeof Message>;
type SessionRecord = z.output<typeof Session>;

export const LOGIN_TOKEN = "login-token";
export const CSRF = "csrf_1";
const NOW = Date.now();
export const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

export class FakeService {
  agents = new Map<string, AgentRecord>();
  asks = new Map<string, AskRecord>();
  messages = new Map<string, MessageRecord>();
  sessions: SessionRecord[] = [];
  /** Every user operation the page called, with its request and caller. */
  calls: [string, unknown, Caller][] = [];
  loginTokens = new Set([LOGIN_TOKEN]);
  pageSessions = new Map<string, z.output<typeof PageSession>>();

  addAgent(
    id: string,
    fields: Omit<Partial<AgentRecord>, "status"> & {
      status?: Partial<z.output<typeof Status>>;
    } = {},
  ) {
    const { status, ...rest } = fields;
    this.agents.set(id, {
      id,
      title: `Agent ${id}`,
      purpose: `What ${id} is for.`,
      manager: null,
      created_by: "ses_creator",
      created_at_attach: false,
      state: "active",
      status: status
        ? {
            state: "running",
            summary: "",
            links: [],
            blockers: [],
            updated_at: minutesAgo(5),
            ...status,
          }
        : null,
      created_at: minutesAgo(600),
      closed_at: null,
      ...rest,
    });
  }

  addAsk(
    id: string,
    agent: string,
    ago: number,
    fields: Partial<AskRecord> & { labels?: string[] } = {},
  ) {
    const { labels = ["Yes", "No"], ...rest } = fields;
    this.asks.set(id, {
      id,
      agent,
      session: `ses_${agent}`,
      to: this.agents.get(agent)?.manager ?? null,
      title: `Question ${id}?`,
      context: `Context of ${id}.`,
      options: labels.map((label) => ({ label })),
      recommendation: labels[0] ?? "Yes",
      escalates: [],
      state: "open",
      answer: null,
      opened_at: minutesAgo(ago),
      ...rest,
    });
  }

  addMessage(id: string, from: string, ago: number, fields: Partial<MessageRecord> = {}) {
    this.messages.set(id, {
      id,
      from,
      to: this.agents.get(from)?.manager ?? null,
      kind: "note",
      body: `Body of ${id}.`,
      evidence: [],
      sent_at: minutesAgo(ago),
      read_at: null,
      acknowledged_at: null,
      ...fields,
    });
  }

  async agent_list({ include_closed }: { include_closed: boolean }) {
    const agents = [...this.agents.values()].filter((a) => include_closed || a.state !== "closed");
    return {
      agents: agents.map((agent) => ({
        agent,
        asks_to_answer: [...this.asks.values()].filter(
          (a) => a.to === agent.id && a.state === "open",
        ).length,
        unread_messages: [...this.messages.values()].filter(
          (m) => m.to === agent.id && m.read_at === null,
        ).length,
      })),
    };
  }

  async agent_get({ agent: id }: { agent: string }) {
    const agent = this.agents.get(id);
    if (agent === undefined) throw new NotFound(`no agent ${id}`);
    const asks = [...this.asks.values()];
    return {
      agent,
      own_asks: asks.filter((ask) => ask.agent === id),
      addressed_asks: asks.filter((ask) => ask.to === id),
      messages: [...this.messages.values()].filter((m) => m.from === id || m.to === id),
      sessions: this.sessions.filter((session) => session.agent === id),
    };
  }

  async ask_list({ state }: { state: AskRecord["state"] | null }) {
    const asks = [...this.asks.values()]
      .filter((ask) => state === null || ask.state === state)
      .sort((a, b) => a.opened_at.localeCompare(b.opened_at));
    const ids = new Set(asks.flatMap((ask) => [ask.agent, ask.to ?? ""]));
    return { asks, agents: [...this.agents.values()].filter((agent) => ids.has(agent.id)) };
  }

  async ask_get({ ask: id }: { ask: string }) {
    const ask = this.asks.get(id);
    if (ask === undefined) throw new NotFound(`no ask ${id}`);
    return ask;
  }

  async ask_answer_as_user(
    request: { ask: string; choice?: string | undefined; words?: string | undefined },
    caller: Caller,
  ) {
    this.calls.push(["ask_answer_as_user", request, caller]);
    const ask = await this.ask_get(request);
    if (ask.state !== "open") throw new Conflict(`ask ${ask.id} is ${ask.state}`);
    if (request.choice !== undefined && !ask.options.some((o) => o.label === request.choice)) {
      throw new Invalid(`'${request.choice}' is not one of the ask's options`);
    }
    const answer = {
      choice: request.choice ?? null,
      words: request.words ?? null,
      by: null,
      channel: "page" as const,
      answered_at: new Date().toISOString(),
    };
    const answered = { ...ask, state: "answered" as const, answer };
    this.asks.set(ask.id, answered);
    return answered;
  }

  private async messageToUser(id: string, kind: MessageRecord["kind"]) {
    const message = this.messages.get(id);
    if (message === undefined) throw new NotFound(`no message ${id}`);
    if (message.to !== null || message.kind !== kind)
      throw new Invalid(`not a ${kind} to the user`);
    return message;
  }

  async message_read_as_user(request: { message: string }, caller: Caller) {
    this.calls.push(["message_read_as_user", request, caller]);
    const message = await this.messageToUser(request.message, "note");
    const read = { ...message, read_at: new Date().toISOString() };
    this.messages.set(message.id, read);
    return read;
  }

  async message_ack_as_user(request: { message: string }, caller: Caller) {
    this.calls.push(["message_ack_as_user", request, caller]);
    const message = await this.messageToUser(request.message, "report");
    const now = new Date().toISOString();
    const acknowledged = { ...message, read_at: message.read_at ?? now, acknowledged_at: now };
    this.messages.set(message.id, acknowledged);
    return acknowledged;
  }

  async agent_close_as_user(request: { agent: string }, caller: Caller) {
    this.calls.push(["agent_close_as_user", request, caller]);
    const { agent } = await this.agent_get(request);
    const open = [...this.agents.values()].filter(
      (child) => child.manager === agent.id && child.state !== "closed",
    );
    if (open.length > 0) throw new Conflict(`${agent.title} still has open agents under it`);
    const closed = { ...agent, state: "closed" as const, closed_at: new Date().toISOString() };
    this.agents.set(agent.id, closed);
    const withdrawn = [...this.asks.values()].filter(
      (a) => a.agent === agent.id && a.state === "open",
    );
    for (const ask of withdrawn) this.asks.set(ask.id, { ...ask, state: "withdrawn" });
    return { agent: closed, withdrawn_asks: withdrawn, detached_sessions: [] };
  }

  async redeemLoginToken(token: string) {
    if (!this.loginTokens.delete(token)) throw new Invalid("unknown, used or expired token");
    const n = this.pageSessions.size + 1;
    const session = {
      id: `page_${n}`,
      csrf_token: `csrf_${n}`,
      expires_at: new Date(NOW + 86_400_000).toISOString(),
    };
    this.pageSessions.set(session.id, session);
    return session;
  }

  async getPageSession(id: string) {
    return this.pageSessions.get(id) ?? null;
  }
}

/** The app over a fake service, with helpers that sign in and send the page's requests. */
export function harness() {
  const fake = new FakeService();
  const service = new Proxy(fake, {
    get: (target, name) =>
      name in target
        ? Reflect.get(target, name)
        : async () => {
            throw new Error(`the page called ${String(name)}`);
          },
  }) as unknown as Service;
  const app: Hono<AppEnv> = createApp(service, { token: "agents-token" });
  let cookie = "";
  return {
    fake,
    app,
    /** Sign in through the login link; later requests carry the page session's cookie. */
    async signIn() {
      const response = await app.request(`/ui/login?token=${LOGIN_TOKEN}`);
      cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      return response;
    },
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
    post: (path: string, fields: Record<string, string>) =>
      app.request(path, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      }),
  };
}

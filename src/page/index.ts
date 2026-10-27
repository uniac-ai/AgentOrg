/**
 * The decisions page, mounted at `/`: what waits on the user, the organization, and any agent in
 * full, where the user can step in.
 *
 * Sign-in starts at `/ui/login?token=...`, whose one-time token comes from the `ui_login_link`
 * operation. Redeeming it starts a page session, kept in an HttpOnly, SameSite=Strict cookie, and
 * every form carries that page session's CSRF token. The routes call the service layer as
 * `c.var.service` with `{ channel: "page" }`; the user operations (`ask_answer_as_user`,
 * `message_read_as_user`, `message_ack_as_user`, `agent_close_as_user`) are served nowhere else.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context as HonoContext } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AskAnswerAsUser } from "../contract/index.ts";
import type { AppEnv } from "../http.ts";
import {
  type Caller,
  Conflict,
  NotFound,
  OperationError,
  type Service,
} from "../operations/index.ts";
import {
  type AgentRecord,
  type Context,
  chain,
  inspection,
  messagesToUser,
  type Refusal,
  tree,
} from "./model.ts";
import { STYLESHEET_SOURCE } from "./stylesheet.ts";
import { agentPage, agentPath, decisionsPage, messagePage } from "./views.tsx";

type PageSession = NonNullable<Awaited<ReturnType<Service["getPageSession"]>>>;
type C = HonoContext<AppEnv>;

export const COOKIE = "agentorg_page";
const CALLER: Caller = { channel: "page" };

const HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    `style-src ${STYLESHEET_SOURCE}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; "),
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export const page = new Hono<AppEnv>();

async function respond(c: C, body: string | Promise<string>, status: ContentfulStatusCode = 200) {
  return c.html(await body, status, HEADERS);
}

const signedOut = (c: C, text?: string) => respond(c, messagePage("Signed out", text, true), 401);
const notSent = (c: C, text: string, status: ContentfulStatusCode) =>
  respond(c, messagePage("Not sent", text, false), status);

async function pageSession(c: C): Promise<PageSession | null> {
  const id = getCookie(c, COOKIE);
  return id ? c.var.service.getPageSession(id) : null;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** The form's text fields; a field sent as a file is absent. */
async function form(c: C): Promise<Record<string, string | undefined>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(
    Object.entries(body).map(([name, value]) => [
      name,
      typeof value === "string" ? value : undefined,
    ]),
  );
}

/** The signed-in page session of a form post that carries its CSRF token, or the refusal. */
async function signedInPost(c: C) {
  const session = await pageSession(c);
  if (session === null) return signedOut(c, "Nothing was sent.");
  const fields = await form(c);
  if (!timingSafeEqual(digest(fields.csrf ?? ""), digest(session.csrf_token))) {
    return notSent(c, "This page was out of date.", 403);
  }
  return { session, fields };
}

/** The agents by id, every state included, for names and links. */
async function agentsById(service: Service) {
  const { agents } = await service.agent_list({ include_closed: true }, CALLER);
  return { summaries: agents, byId: new Map(agents.map(({ agent }) => [agent.id, agent])) };
}

/** Read back what was just settled, from `?answered=` or `?closed=`. */
async function settled(c: C, agents: ReadonlyMap<string, AgentRecord>) {
  const closed = c.req.query("closed");
  if (closed !== undefined) return agents.get(closed);
  const answered = c.req.query("answered");
  if (answered === undefined) return undefined;
  try {
    const ask = await c.var.service.ask_get({ ask: answered }, CALLER);
    return ask.state === "open" ? undefined : ask;
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    throw error;
  }
}

async function renderDecisions(c: C, session: PageSession, extra: Partial<Context> = {}) {
  const service = c.var.service;
  const [{ summaries, byId }, { asks }] = await Promise.all([
    agentsById(service),
    service.ask_list({ state: "open" }, CALLER),
  ]);
  const open = summaries.filter(({ agent }) => agent.state !== "closed");
  const topLevel = open.filter(({ agent }) => agent.manager === null);
  const details = await Promise.all(
    topLevel.map(({ agent }) => service.agent_get({ agent: agent.id }, CALLER)),
  );
  const asksById = new Map(asks.map((ask) => [ask.id, ask]));
  const model = {
    asks: asks.filter((ask) => ask.to === null).map((ask) => chain(ask, asksById)),
    messages: messagesToUser(details),
    organization: tree(open),
  };
  const ctx: Context = {
    agents: byId,
    csrfToken: session.csrf_token,
    settled: await settled(c, byId),
    ...extra,
  };
  return decisionsPage(model, ctx);
}

async function renderAgent(c: C, session: PageSession, id: string, extra: Partial<Context> = {}) {
  const service = c.var.service;
  const [detail, { summaries, byId }] = await Promise.all([
    service.agent_get({ agent: id }, CALLER),
    agentsById(service),
  ]);
  const model = inspection(detail, summaries, c.req.query("close") === "confirm");
  const ctx: Context = {
    agents: byId,
    csrfToken: session.csrf_token,
    settled: await settled(c, byId),
    ...extra,
  };
  return agentPage(model, ctx);
}

/** Where a form returns to: the decisions or one agent's page, never anywhere else. */
function backTo(value: string | undefined): { path: string; agent?: string } {
  const match = /^\/agents\/([^/?#]+)$/.exec(value ?? "");
  const agent = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
  return agent === undefined ? { path: "/" } : { path: agentPath(agent), agent };
}

/** Run a page's read, turning an unknown agent into a 404 page. */
async function read(c: C, render: () => Promise<string>, status: ContentfulStatusCode = 200) {
  try {
    return await respond(c, render(), status);
  } catch (error) {
    if (error instanceof NotFound) return notSent(c, error.message, 404);
    throw error;
  }
}

page.get("/", async (c) => {
  const session = await pageSession(c);
  if (session === null) return signedOut(c);
  return read(c, () => renderDecisions(c, session));
});

page.get("/agents/:agent", async (c) => {
  const session = await pageSession(c);
  if (session === null) return signedOut(c);
  return read(c, () => renderAgent(c, session, c.req.param("agent")));
});

page.get("/ui/login", async (c) => {
  let session: PageSession;
  try {
    session = await c.var.service.redeemLoginToken(c.req.query("token") ?? "");
  } catch (error) {
    if (error instanceof OperationError)
      return signedOut(c, "This sign-in link is used or expired.");
    throw error;
  }
  setCookie(c, COOKIE, session.id, {
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    expires: new Date(session.expires_at),
  });
  return c.redirect("/", 303);
});

page.post("/ui/asks/:ask/answer", async (c) => {
  const post = await signedInPost(c);
  if (post instanceof Response) return post;
  const { session, fields } = post;
  const ask = c.req.param("ask");
  const back = backTo(fields.back);
  const choice = fields.choice || undefined;
  const words = fields.words?.trim() || undefined;
  const refuse = (message: string) => {
    const refusal: Refusal = { target: ask, message, choice, words };
    const render = () =>
      back.agent === undefined
        ? renderDecisions(c, session, { refusal })
        : renderAgent(c, session, back.agent, { refusal });
    return read(c, render, 422);
  };
  if (choice === undefined && words === undefined)
    return refuse("Choose an option or write a note.");
  const request = AskAnswerAsUser.safeParse({ ask, choice, words });
  if (!request.success) return refuse(request.error.issues[0]?.message ?? "Not a valid answer.");
  try {
    await c.var.service.ask_answer_as_user(request.data, CALLER);
  } catch (error) {
    if (error instanceof NotFound) return notSent(c, "There is no such ask.", 404);
    // Answered or withdrawn meanwhile: the confirmation shows what the record holds.
    if (!(error instanceof Conflict)) {
      if (error instanceof OperationError) return refuse(error.message);
      throw error;
    }
  }
  return c.redirect(`${back.path}?answered=${encodeURIComponent(ask)}`, 303);
});

for (const [verb, operation] of [
  ["read", "message_read_as_user"],
  ["ack", "message_ack_as_user"],
] as const) {
  page.post(`/ui/messages/:message/${verb}`, async (c) => {
    const post = await signedInPost(c);
    if (post instanceof Response) return post;
    try {
      await c.var.service[operation]({ message: c.req.param("message") }, CALLER);
    } catch (error) {
      if (error instanceof NotFound) return notSent(c, "There is no such message.", 404);
      if (error instanceof Conflict) return c.redirect("/", 303);
      if (error instanceof OperationError) return notSent(c, error.message, 422);
      throw error;
    }
    return c.redirect("/", 303);
  });
}

page.post("/ui/agents/:agent/close", async (c) => {
  const post = await signedInPost(c);
  if (post instanceof Response) return post;
  const agent = c.req.param("agent");
  try {
    await c.var.service.agent_close_as_user({ agent }, CALLER);
  } catch (error) {
    if (error instanceof NotFound) return notSent(c, "There is no such agent.", 404);
    if (error instanceof OperationError) {
      const refusal: Refusal = { target: "close", message: error.message };
      return read(c, () => renderAgent(c, post.session, agent, { refusal }), 422);
    }
    throw error;
  }
  return c.redirect(`/?closed=${encodeURIComponent(agent)}`, 303);
});

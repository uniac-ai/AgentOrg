/**
 * The page's JSON routes under `/ui/api`, for the web app only: reads of the record, and the user
 * operations, which no other surface serves. Every route needs the cookie of a signed-in page
 * session, and every write also carries that session's CSRF token in the `X-CSRF-Token` header.
 * These routes are not part of the contract or `openapi.json`.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { errorResponse } from "../api/index.ts";
import { OPERATIONS, type OperationName } from "../contract/index.ts";
import type { AppEnv } from "../http.ts";
import { type Caller, Invalid, invalid, OperationError } from "../operations/index.ts";
import { CSRF_HEADER, type PageActivity, type PageBootstrap } from "./types.ts";

export const COOKIE = "agentorg_page";
const CALLER: Caller = { channel: "page" };

type PageSession = NonNullable<
  Awaited<ReturnType<AppEnv["Variables"]["service"]["getPageSession"]>>
>;
type PageEnv = { Variables: AppEnv["Variables"] & { pageSession: PageSession } };
type Untyped = (request: unknown, caller: Caller) => Promise<unknown>;

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Parse a request with the operation's own schema, call it as the user, and return its result. */
async function run(c: Context<PageEnv>, name: OperationName, request: unknown) {
  const parsed = OPERATIONS[name].request.safeParse(request);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const operation = c.var.service[name] as Untyped;
  return c.json(await operation(parsed.data, CALLER));
}

async function body(c: Context<PageEnv>): Promise<object> {
  const value: unknown = await c.req.json().catch(() => undefined);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Invalid("the body must be a JSON object");
  }
  return value;
}

export function pageApi(): Hono<PageEnv> {
  const api = new Hono<PageEnv>();

  api.use(async (c, next) => {
    const id = getCookie(c, COOKIE);
    const session = id ? await c.var.service.getPageSession(id) : null;
    c.header("Cache-Control", "no-store");
    if (session === null) {
      return c.json({ code: "signed_out", message: "Run agentorg ui to sign in." }, 401);
    }
    const token = c.req.header(CSRF_HEADER) ?? "";
    if (c.req.method !== "GET" && !timingSafeEqual(digest(token), digest(session.csrf_token))) {
      return c.json(
        { code: "forbidden", message: "The page's CSRF token is missing or stale." },
        403,
      );
    }
    c.set("pageSession", session);
    await next();
  });

  api.onError((error, c) => {
    if (error instanceof OperationError) return errorResponse(c, error);
    console.error(error);
    return c.json({ code: "error", message: "The service failed; see its log." }, 500);
  });

  api.get("/session", (c) => {
    const { csrf_token, expires_at } = c.var.pageSession;
    return c.json({ csrf_token, expires_at } satisfies PageBootstrap);
  });

  api.get("/agents", (c) => run(c, "agent_list", { include_closed: true }));
  api.get("/view/:entity", (c) => {
    const entity = c.req.param("entity");
    return run(c, "view_as_user", { agent: entity === "user" ? null : entity });
  });
  api.get("/asks", (c) => {
    const state = c.req.query("state");
    return run(c, "ask_list", state === "all" ? { state: null } : { state });
  });
  api.get("/asks/:ask", (c) => run(c, "ask_get", { ask: c.req.param("ask") }));
  /** The audit trail without the page's own sign-in links, each status set with its summary. */
  api.get("/activity", async (c) => {
    const limit = c.req.query("limit");
    const request = OPERATIONS.audit_list.request.safeParse(
      limit === undefined ? {} : { limit: Number(limit) },
    );
    if (!request.success) throw invalid(request.error.issues);
    const service = c.var.service;
    const { entries } = await service.audit_list(request.data, CALLER);
    const setters = entries.filter((entry) => entry.operation === "status_set" && entry.agent);
    const agents = [...new Set(setters.map((entry) => entry.agent as string))];
    const statuses = (
      await Promise.all(agents.map((agent) => service.agent_get({ agent }, CALLER)))
    ).flatMap((detail) => detail.status_history);
    // A status's audit line is written just after the status, by the same session.
    const summaryOf = (entry: (typeof entries)[number]) =>
      statuses
        .filter((status) => status.session === entry.session && status.at <= entry.at)
        .reduce<(typeof statuses)[number] | undefined>(
          (latest, status) => (latest && latest.at > status.at ? latest : status),
          undefined,
        )?.summary;
    return c.json({
      entries: entries
        .filter((entry) => entry.operation !== "ui_login_link")
        .map((entry) =>
          entry.operation === "status_set"
            ? { ...entry, summary: summaryOf(entry) ?? null }
            : entry,
        ),
      more: entries.length === request.data.limit,
    } satisfies PageActivity);
  });

  api.post("/asks/:ask/answer", async (c) =>
    run(c, "ask_answer_as_user", { ...(await body(c)), ask: c.req.param("ask") }),
  );
  api.post("/messages/:message/read", (c) =>
    run(c, "message_read_as_user", { message: c.req.param("message") }),
  );
  api.post("/messages/:message/ack", (c) =>
    run(c, "message_ack_as_user", { message: c.req.param("message") }),
  );
  api.post("/agents/:agent/close", (c) =>
    run(c, "agent_close_as_user", { agent: c.req.param("agent") }),
  );

  return api;
}

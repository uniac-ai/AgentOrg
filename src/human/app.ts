/**
 * The human actor's HTTP surface, on its own origin: sign-in, and the web app's API under `/api`.
 *
 * `POST /signin/link` mints a one-time sign-in link for `agentorg ui`, which presents the root
 * credential; like every agent surface it refuses requests from web pages. `GET /signin` redeems a
 * link into a session cookie. Every `/api` route needs that cookie, and every write also carries
 * the session's CSRF token in the `X-CSRF-Token` header. Answering a pending call completes it from
 * the human's queue; every other route passes through to the core over the human actor's own
 * connection, so the web app never talks to the core.
 */

import { type CallToolResult, McpError } from "@modelcontextprotocol/sdk/types.js";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { type Core, CoreUnreachable } from "./core.ts";
import type { Queue } from "./queue.ts";
import { COOKIE, matches, type Session, type SignIn } from "./signin.ts";
import { answerOf } from "./tools.ts";
import {
  type ApiErrorBody,
  CSRF_HEADER,
  type PendingList,
  type SessionBootstrap,
} from "./types.ts";

class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;

  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Env = { Variables: { session: Session } };

const resultText = (result: CallToolResult) =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** A call's structured result; a refusal becomes an error response. */
function structured(result: CallToolResult): Record<string, unknown> {
  if (result.isError) throw new ApiError(400, "refused", resultText(result));
  return result.structuredContent ?? {};
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => undefined);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid", "the body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function humanApp(options: {
  core: Core;
  queue: Queue;
  signIn: SignIn;
  credential: string;
}): Hono {
  const { core, queue, signIn, credential } = options;
  const app = new Hono();

  app.onError((error, c) => {
    const known =
      error instanceof ApiError
        ? error
        : error instanceof McpError
          ? new ApiError(400, "refused", error.message)
          : error instanceof CoreUnreachable
            ? new ApiError(503, "core_unreachable", error.message)
            : undefined;
    if (known === undefined) {
      console.error(error);
      return c.json({ code: "error", message: "The human actor failed; see its log." }, 500);
    }
    return c.json(
      { code: known.code, message: known.message } satisfies ApiErrorBody,
      known.status,
    );
  });

  app.post("/signin/link", (c) => {
    if (c.req.header("origin") !== undefined) {
      return c.json({ code: "forbidden", message: "requests from web pages are refused" }, 403);
    }
    const [scheme = "", presented = ""] = (c.req.header("authorization") ?? "").split(" ");
    if (scheme.toLowerCase() !== "bearer" || !matches(presented, credential)) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ code: "unauthorized", message: "the root credential is required" }, 401);
    }
    return c.json(signIn.link());
  });

  app.get("/signin", (c) => {
    const session = signIn.redeem(c.req.query("token") ?? "");
    // A used or expired link opens the app signed out, which says how to sign in.
    if (session) {
      setCookie(c, COOKIE, session.cookie, {
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
        expires: session.expires,
      });
    }
    return c.redirect("/", 303);
  });

  const api = new Hono<Env>();

  api.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    const session = signIn.session(getCookie(c, COOKIE));
    if (session === undefined) {
      throw new ApiError(401, "signed_out", "Run agentorg ui to sign in.");
    }
    if (c.req.method !== "GET" && !matches(c.req.header(CSRF_HEADER) ?? "", session.csrf_token)) {
      throw new ApiError(403, "forbidden", "The CSRF token is missing or stale.");
    }
    c.set("session", session);
    await next();
  });

  api.get("/session", (c) => c.json(c.var.session satisfies SessionBootstrap));

  api.get("/pending", async (c) =>
    c.json({ pending: await queue.pending() } satisfies PendingList),
  );

  api.post("/pending/:call", async (c) => {
    const id = c.req.param("call");
    const call = (await queue.pending()).find((each) => each.call === id);
    const output = call && answerOf(call.tool, call.input, await body(c));
    if (output?.success === false)
      throw new ApiError(400, "invalid", z.prettifyError(output.error));
    if (!output || !(await queue.complete(id, output.data))) {
      throw new ApiError(404, "not_found", "No call with this id waits on you.");
    }
    return c.json({ call: id, output: output.data });
  });

  api.get("/tools", async (c) => c.json({ tools: await core.tools() }));

  api.post("/tools/:name", async (c) =>
    c.json(await core.call(c.req.param("name"), await body(c))),
  );

  api.get("/view", async (c) => c.json(structured(await core.call("view", {}))));
  api.get("/view/:actor", async (c) =>
    c.json(structured(await core.call("view", { actor: c.req.param("actor") }))),
  );

  api.get("/activity", async (c) => {
    const { since, limit } = c.req.query();
    const request = Object.fromEntries(
      Object.entries({ since, limit }).flatMap(([key, value]) =>
        value ? [[key, Number(value)]] : [],
      ),
    );
    return c.json(structured(await core.call("activity", request)));
  });

  app.route("/api", api);
  return app;
}

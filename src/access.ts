/**
 * Agent access to the API and MCP surfaces: a bearer token, and no browser requests.
 *
 * A request that carries an `Origin` header comes from a web page, so it is refused; this blocks
 * DNS rebinding. The decisions page has its own cookie sign-in and is not covered here.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function agentAccess(token: string): MiddlewareHandler {
  if (!token) throw new Error("the bearer token is empty");
  const expected = digest(token);
  return async (c, next) => {
    if (c.req.header("origin") !== undefined) {
      return c.json({ code: "forbidden", message: "requests from web pages are refused" }, 403);
    }
    const [scheme = "", credentials = ""] = (c.req.header("authorization") ?? "").split(" ");
    if (scheme.toLowerCase() !== "bearer" || !timingSafeEqual(digest(credentials), expected)) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ code: "unauthorized", message: "a valid bearer token is required" }, 401);
    }
    await next();
  };
}

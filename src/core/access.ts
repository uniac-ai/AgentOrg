/**
 * Access to both endpoints: a request names its actor with `Authorization: Bearer <credential>`,
 * and a request with an `Origin` header comes from a web page, so it is refused. That blocks DNS
 * rebinding and cross-site WebSockets, which browsers open without asking the server.
 */

import type { MiddlewareHandler } from "hono";
import type { Connections } from "./connections.ts";

export type CoreEnv = { Variables: { actor: string } };

export function actorAccess(connections: Connections): MiddlewareHandler<CoreEnv> {
  return async (c, next) => {
    if (c.req.header("origin") !== undefined) {
      return c.json({ code: "forbidden", message: "requests from web pages are refused" }, 403);
    }
    const [scheme = "", credential = ""] = (c.req.header("authorization") ?? "").split(" ");
    const actor = scheme.toLowerCase() === "bearer" ? connections.identify(credential) : undefined;
    if (!actor) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ code: "unauthorized", message: "a valid actor credential is required" }, 401);
    }
    c.set("actor", actor.id);
    await next();
  };
}

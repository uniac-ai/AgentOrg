/**
 * Access to both endpoints: a request names its party with `Authorization: Bearer <credential>`,
 * and a request with an `Origin` header comes from a web page, so it is refused. That blocks DNS
 * rebinding and cross-site WebSockets, which browsers open without asking the server.
 */

import type { MiddlewareHandler } from "hono";

export type NetworkEnv = { Variables: { party: string } };

/** Who a credential is, as the core's owner of credentials knows it. */
export interface Identities {
  identify(credential: string): string | undefined;
}

export function access(identities: Identities): MiddlewareHandler<NetworkEnv> {
  return async (c, next) => {
    if (c.req.header("origin") !== undefined) {
      return c.json({ code: "forbidden", message: "requests from web pages are refused" }, 403);
    }
    const [scheme = "", credential = ""] = (c.req.header("authorization") ?? "").split(" ");
    const party = scheme.toLowerCase() === "bearer" ? identities.identify(credential) : undefined;
    if (!party) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ code: "unauthorized", message: "a valid credential is required" }, 401);
    }
    c.set("party", party);
    await next();
  };
}

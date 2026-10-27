/** What the app's HTTP surfaces share: the context they run in and the caller they build. */

import type { Context } from "hono";
import type { z } from "zod";
import type { Channel } from "./contract/index.ts";
import type { Caller, Service } from "./operations/index.ts";

export const CLIENT_HEADER = "Agentorg-Client";
export const CLIENT_SESSION_HEADER = "Agentorg-Client-Session-Id";

/** Every route reads the service layer from `c.var.service`. */
export interface AppEnv {
  Variables: { service: Service };
}

/** The caller of an HTTP request, from the client headers the transport sets. */
export function callerFrom(c: Context, channel: z.output<typeof Channel>): Caller {
  return {
    channel,
    client: c.req.header(CLIENT_HEADER),
    clientSessionId: c.req.header(CLIENT_SESSION_HEADER),
  };
}

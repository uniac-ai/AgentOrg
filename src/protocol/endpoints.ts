/** Where the core listens, how an actor proves who it is, and the metadata calls carry. */

export const DEFAULT_CORE_PORT = 8740;

/** Streamable HTTP: the core is the MCP server, and the actor its client. */
export const MCP_PATH = "/mcp";

/** A WebSocket the actor opens: the core is the MCP client, and the actor its server. */
export const REVERSE_PATH = "/mcp/reverse";

/** The WebSocket subprotocol of the reverse connection: one JSON-RPC message per text frame. */
export const SUBPROTOCOL = "mcp";

/** The core closes a reverse connection with these codes. */
export const CLOSE_REPLACED = 4000;
export const CLOSE_ACTOR_CLOSED = 4001;

/** The handle under which an actor sees its manager's tools, as in `manager.decide`. */
export const MANAGER = "manager";

/**
 * `_meta` key on a call. On a `tools/call` the core delivers to an actor it holds `DeliveredCall`.
 * On the result of a routed `tools/call` on `/mcp` it holds `CallReceipt`.
 */
export const CALL_META = "agentorg/call";

/**
 * `_meta` key an actor sets on a `tools/call` to `/mcp` while it handles a call: the id of that
 * call, recorded as the new call's `cause`.
 */
export const CAUSE_META = "agentorg/cause";

export interface DeliveredCall {
  /** The call's id. Delivery is at least once, so a handler that sees an id again is seeing a repeat. */
  id: string;
  /** The calling actor's id. */
  from: string;
  /** The call that led to this one, if the caller named it. */
  cause: string | null;
}

export interface CallReceipt {
  id: string;
  state: "pending" | "done" | "failed" | "withdrawn";
}

/** The core's address for clients: `AGENTORG_URL`, else 127.0.0.1 at `AGENTORG_PORT` or 8740. */
export function coreUrl(): string {
  const port = process.env.AGENTORG_PORT || DEFAULT_CORE_PORT;
  return (process.env.AGENTORG_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
}

/**
 * The MCP binding: the only code that imports `@modelcontextprotocol/*`. It encodes the domain's
 * operations as MCP, both ways, and nothing else depends on how.
 *
 * - `encoding.ts`: interfaces as tools, calls as `tools/call` with `_meta`, runs as tasks, and
 *   outcomes and answers as tool results.
 * - `inbound.ts`: the core's MCP server on the request endpoint, over the domain's Application.
 * - `outbound.ts`: the core's MCP client on each actor's channel, as that actor's link, telling
 *   the domain's Presence when it can be reached.
 * - `actor.ts`: an actor's side, behind the actor library's API.
 * - `transport.ts`: an MCP transport over a network channel.
 * - `legacy-actor-connection.ts`: kept for `src/human/` until it moves onto `src/actor/`.
 */

import type { Application, Presence } from "../../domain/ports.ts";
import type { Endpoints } from "../../network/index.ts";
import { serveRequest } from "./inbound.ts";
import { attach } from "./outbound.ts";

export * from "./encoding.ts";

/** The core's endpoints, as MCP over the domain's two faces. */
export function mcpEndpoints(
  domain: Application & Presence,
  options: { timeoutMs: number; onError?: (party: string, error: Error) => void },
): Endpoints {
  return {
    request: (party, request) => serveRequest(domain, party, request),
    channel: (party, channel) => attach(domain, party, channel, options),
  };
}

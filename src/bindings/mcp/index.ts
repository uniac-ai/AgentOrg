/** Hub MCP exposure and reverse Actor delivery over one identity-admitted connection. */
import type { Application, Presence } from "../../domain/ports.ts";
import type { Channel } from "../../network/index.ts";
import { serveActor } from "./inbound.ts";
import { attach } from "./outbound.ts";
import { mcpTransports } from "./transport.ts";

export * from "./encoding.ts";

export function serveConnection(
  domain: Application & Presence,
  actorId: string,
  channel: Channel,
  options: { timeoutMs: number; onError?: (party: string, error: Error) => void },
): void {
  const transports = mcpTransports(channel);
  if (transports.server) void serveActor(domain, actorId, transports.server);
  attach(domain, actorId, channel, transports.client, options);
}

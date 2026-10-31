/** Explicit Hub MCP Tools on one Actor-initiated, identity-admitted connection. */
import type { Application } from "../../domain/ports.ts";
import type { Channel } from "../../network/index.ts";
import { serveActor } from "./inbound.ts";
import { mcpTransport } from "./transport.ts";

export * from "./encoding.ts";

export function serveConnection(
  domain: Application,
  actorId: string,
  channel: Channel,
  options: {
    connectionId?: string;
    observe?: (code: "mcp_initialization_failed" | "protocol_invalid") => void;
    onError?: (party: string, error: Error) => void;
  },
): void {
  void serveActor(
    domain,
    actorId,
    mcpTransport(channel, () => options.observe?.("protocol_invalid")),
    options.connectionId,
  ).catch(() => {
    options.observe?.("mcp_initialization_failed");
    options.onError?.(actorId, new Error("Hub MCP initialization failed"));
    channel.close();
  });
}

/** Fixed MCP client/server directions on one admitted JSON-RPC channel. No wire wrapper is added. */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Channel } from "../../network/index.ts";

class Direction implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private pending: JSONRPCMessage[] | undefined = [];
  private ended = false;
  private readonly channel: Channel;
  constructor(channel: Channel) {
    this.channel = channel;
  }
  async start(): Promise<void> {
    const pending = this.pending ?? [];
    this.pending = undefined;
    for (const message of pending) this.onmessage?.(message);
  }
  receive(message: JSONRPCMessage): void {
    if (this.ended) return;
    if (this.pending) this.pending.push(message);
    else this.onmessage?.(message);
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ended) throw new Error("MCP direction closed");
    this.channel.send(JSON.stringify(message));
  }
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.pending = undefined;
    this.onclose?.();
  }
}

/**
 * Each end's client issues requests; each end's server answers them. Replies and progress go
 * to the local client; requests, initialization and request cancellation go to its server.
 * Request IDs are owned independently in each direction and retain their JSON types.
 */
export function mcpTransports(
  channel: Channel,
  exposes = true,
): { client: Transport; server: Transport | undefined } {
  const client = new Direction(channel);
  const server = exposes ? new Direction(channel) : undefined;
  channel.listen(
    (text) => {
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(text));
      } catch {
        client.onerror?.(new Error("Invalid MCP JSON-RPC message"));
        return;
      }
      if (!("method" in message)) {
        client.receive(message);
        return;
      }
      if (
        "id" in message ||
        message.method === "notifications/initialized" ||
        message.method === "notifications/cancelled"
      ) {
        if (server) server.receive(message);
        else if ("id" in message)
          channel.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Method not found" },
            }),
          );
      } else client.receive(message);
    },
    () => {
      void client.close();
      void server?.close();
    },
  );
  return { client, server };
}

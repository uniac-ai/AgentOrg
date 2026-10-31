/** One MCP endpoint over an admitted bidirectional JSON-RPC channel. */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Channel } from "../../network/index.ts";

export function mcpTransport(channel: Channel): Transport {
  const transport: Transport = {
    async start() {
      channel.listen(
        (text) => {
          try {
            transport.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(text)));
          } catch {
            transport.onerror?.(new Error("Invalid MCP JSON-RPC message"));
          }
        },
        () => transport.onclose?.(),
      );
    },
    async send(message) {
      channel.send(JSON.stringify(message));
    },
    async close() {
      channel.close();
    },
  };
  return transport;
}

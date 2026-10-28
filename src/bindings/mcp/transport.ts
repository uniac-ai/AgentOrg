/**
 * An MCP transport over a network channel: one JSON-RPC message per text frame. Either end uses
 * it, since the SDK has a WebSocket transport for clients only.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Channel } from "../../network/index.ts";

export class ChannelTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly channel: Channel;

  constructor(channel: Channel) {
    this.channel = channel;
  }

  async start(): Promise<void> {
    this.channel.listen(
      (text) => {
        let message: JSONRPCMessage;
        try {
          message = JSONRPCMessageSchema.parse(JSON.parse(text));
        } catch (error) {
          this.onerror?.(error as Error);
          return;
        }
        this.onmessage?.(message);
      },
      () => this.onclose?.(),
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.channel.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.channel.close();
  }
}

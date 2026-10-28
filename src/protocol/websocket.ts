/**
 * The reverse connection's transport: MCP JSON-RPC over one WebSocket, one message per text frame.
 * Either end wraps its socket in it, the core the socket it accepted and an actor the one it
 * dialed, since the SDK has a WebSocket transport for clients only. The socket's owner feeds it
 * frames with `receive` and the socket's end with `closed`.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { REVERSE_PATH, SUBPROTOCOL } from "./endpoints.ts";

export interface FrameSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export class WebSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** The WebSocket close code, once the socket has closed. */
  closeCode: number | undefined;
  private readonly socket: FrameSocket;
  /** Frames that arrive before the protocol starts, such as the core's `initialize`. */
  private early: JSONRPCMessage[] | undefined = [];
  private ended = false;

  constructor(socket: FrameSocket) {
    this.socket = socket;
  }

  async start(): Promise<void> {
    const early = this.early ?? [];
    this.early = undefined;
    for (const message of early) this.onmessage?.(message);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ended) throw new Error("the connection is closed");
    this.socket.send(JSON.stringify(message));
  }

  async close(code?: number, reason?: string): Promise<void> {
    if (!this.ended) this.socket.close(code, reason);
    this.closed();
  }

  receive(text: string): void {
    let message: JSONRPCMessage;
    try {
      message = JSONRPCMessageSchema.parse(JSON.parse(text));
    } catch (error) {
      this.onerror?.(error as Error);
      return;
    }
    if (this.early) this.early.push(message);
    else this.onmessage?.(message);
  }

  closed(code?: number): void {
    if (this.ended) return;
    this.ended = true;
    this.closeCode = code;
    this.onclose?.();
  }
}

/** Open an actor's reverse connection to the core at `coreUrl`, once the socket is open. */
export async function dialReverse(
  coreUrl: string,
  credential: string,
): Promise<WebSocketTransport> {
  const url = new URL(REVERSE_PATH, coreUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Node's WebSocket takes headers, which the browser's does not.
  const init = { protocols: [SUBPROTOCOL], headers: { Authorization: `Bearer ${credential}` } };
  const socket = new WebSocket(url, init as unknown as string[]);
  const transport = new WebSocketTransport({
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  });
  socket.onmessage = (event) => transport.receive(String(event.data));
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onclose = (event) =>
      reject(new Error(`the core refused the reverse connection (${event.code})`));
  });
  socket.onclose = (event) => transport.closed(event.code);
  return transport;
}

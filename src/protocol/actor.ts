/**
 * An actor's two connections to the core, for actors built on the MCP SDK: its client on `/mcp`,
 * which calls its available tools, and its own server on `/mcp/reverse`, which the core calls.
 * The reverse connection is dialed again whenever it drops, with the same server, so tasks the
 * server holds survive a reconnect; but not when the core ended it for good, because a newer
 * connection replaced it or the actor was closed.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CLOSE_ACTOR_CLOSED, CLOSE_REPLACED, MCP_PATH } from "./endpoints.ts";
import { dialReverse, type WebSocketTransport } from "./websocket.ts";

export interface ActorConnectionOptions {
  /** The core's address, such as `http://127.0.0.1:8740`. */
  url: string;
  credential: string;
  /** The actor's MCP server: its exposed tools. */
  server: Server;
  /** The client's name in its MCP `initialize`. */
  name?: string;
  /** The longest pause between dials of the reverse connection. */
  maxRetryMs?: number;
}

export class ActorConnection {
  readonly client: Client;
  /** The close code with which the core ended the reverse connection for good. */
  ended: number | undefined;
  private readonly options: ActorConnectionOptions;
  private reverse: WebSocketTransport | undefined;
  private closing = false;

  constructor(options: ActorConnectionOptions) {
    this.options = options;
    this.client = new Client({ name: options.name ?? "agentorg-actor", version: "0" });
  }

  /** Connect both, failing when the core refuses either. */
  async open(): Promise<void> {
    const { url, credential } = this.options;
    await this.client.connect(
      new StreamableHTTPClientTransport(new URL(MCP_PATH, url), {
        requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      }),
    );
    await this.dial();
  }

  private async dial(): Promise<void> {
    const transport = await dialReverse(this.options.url, this.options.credential);
    this.reverse = transport;
    await this.options.server.connect(transport);
    this.options.server.onclose = () => {
      if (this.reverse !== transport || this.closing) return;
      const code = transport.closeCode;
      if (code === CLOSE_REPLACED || code === CLOSE_ACTOR_CLOSED) this.ended = code;
      else void this.redial();
    };
  }

  private async redial(): Promise<void> {
    for (
      let pause = 250;
      !this.closing;
      pause = Math.min(pause * 2, this.options.maxRetryMs ?? 10_000)
    ) {
      await new Promise((resolve) => setTimeout(resolve, pause));
      if (this.closing) return;
      try {
        await this.dial();
        return;
      } catch {
        // The core is down or refused; try again after the next pause.
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([this.client.close(), this.reverse?.close()]);
  }
}

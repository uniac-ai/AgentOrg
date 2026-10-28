/**
 * A party's side of the network: requests to the core's request endpoint carrying the party's
 * credential, and its channel, dialed again whenever it drops. It stops dialing when the core
 * ended the channel for good: replaced by a newer one, or revoked.
 */

import { type Channel, dial } from "./channel.ts";
import { CLOSE_REPLACED, CLOSE_REVOKED } from "./codes.ts";
import type { Paths } from "./listener.ts";

/** The causes of a failed `fetch` that mean its connection was already closed by the core. */
const CLOSED = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

export interface ConnectorOptions {
  /** The core's address, such as `http://127.0.0.1:8740`. */
  url: string;
  credential: string;
  paths: Paths;
  /** The channel's WebSocket subprotocol. */
  subprotocol: string;
  /** The longest pause between dials. */
  maxRetryMs?: number;
}

export class Connector {
  /** The close code with which the core ended the channel for good. */
  ended: number | undefined;
  readonly requestUrl: URL;
  private readonly options: ConnectorOptions;
  private channel: Channel | undefined;
  private closing = false;

  constructor(options: ConnectorOptions) {
    this.options = options;
    this.requestUrl = new URL(options.paths.request, options.url);
  }

  /**
   * `fetch`, with the credential on every request. A request sent on a kept-alive connection the
   * core has closed, as when it restarted, fails as the connection resets or ends; it is sent once
   * more, on a new one.
   */
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.options.credential}`);
    try {
      return await fetch(input, { ...init, headers });
    } catch (error) {
      if (!CLOSED.has((error as { cause?: { code?: string } }).cause?.code ?? "")) throw error;
      return fetch(input, { ...init, headers });
    }
  };

  /**
   * Dial the channel and give each one that opens to `use`, which takes its frames. It resolves
   * once the first channel is in use, and fails when the core refuses the first dial.
   */
  async connect(use: (channel: Channel) => Promise<void>): Promise<void> {
    await this.dial(use);
  }

  private async dial(use: (channel: Channel) => Promise<void>): Promise<void> {
    const url = new URL(this.options.paths.channel, this.options.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const channel = await dial(url, this.options.credential, this.options.subprotocol);
    this.channel = channel;
    const ended = () => {
      if (this.channel !== channel || this.closing) return;
      const code = channel.closeCode;
      if (code === CLOSE_REPLACED || code === CLOSE_REVOKED) this.ended = code;
      else void this.redial(use);
    };
    await use(channel);
    channel.whenClosed(ended);
  }

  private async redial(use: (channel: Channel) => Promise<void>): Promise<void> {
    const most = this.options.maxRetryMs ?? 10_000;
    for (let pause = 250; !this.closing; pause = Math.min(pause * 2, most)) {
      await new Promise((resolve) => setTimeout(resolve, pause));
      if (this.closing) return;
      try {
        await this.dial(use);
        return;
      } catch {
        // The core is down or refused; try again after the next pause.
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.channel?.close();
  }
}

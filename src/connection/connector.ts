/** Reconnect one identity; each socket completes fresh admission before MCP initializes. */
import { type Channel, CLOSE_REVOKED, dial } from "../network/index.ts";
import { CONNECTION_PATH, establish, type Identity } from "./index.ts";

export class Connector {
  ended: number | undefined;
  private channel: Channel | undefined;
  private closing = false;
  private readonly options: { url: string; identity: Identity; maxRetryMs?: number };
  constructor(options: { url: string; identity: Identity; maxRetryMs?: number }) {
    this.options = options;
  }
  async connect(use: (channel: Channel) => Promise<void>): Promise<void> {
    await this.dial(use);
  }
  private async dial(use: (channel: Channel) => Promise<void>): Promise<void> {
    const url = new URL(CONNECTION_PATH, this.options.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const raw = await dial(url);
    this.channel = raw;
    try {
      const connection = await establish(raw, this.options.identity);
      await use(connection.channel);
    } catch (error) {
      raw.close();
      throw error;
    }
    raw.whenClosed((code) => {
      if (this.channel !== raw || this.closing) return;
      if (code === CLOSE_REVOKED) this.ended = code;
      else void this.redial(use);
    });
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
        /* The next socket gets fresh admission. */
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    this.channel?.close();
  }
}

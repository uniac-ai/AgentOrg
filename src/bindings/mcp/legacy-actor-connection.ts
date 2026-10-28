/**
 * Legacy: the MCP-level connection `src/human/` was built on, kept only until the human actor
 * moves onto the actor library (`src/actor/`), right after its web app's move. Delete this file
 * then, with the layers test's exception for `src/human/`. New code uses `src/actor/`.
 *
 * It dials the request endpoint as an MCP client and serves `server` on the channel, dialing the
 * channel again whenever it drops, except when the core ended it for good.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Connector } from "../../network/index.ts";
import { PATHS, SUBPROTOCOL } from "./encoding.ts";
import { ChannelTransport } from "./transport.ts";

export interface ActorConnectionOptions {
  url: string;
  credential: string;
  server: Server;
  name?: string;
  maxRetryMs?: number;
}

export class ActorConnection {
  readonly client: Client;
  private readonly connector: Connector;
  private readonly server: Server;

  constructor(options: ActorConnectionOptions) {
    this.server = options.server;
    this.client = new Client({ name: options.name ?? "agentorg-actor", version: "0" });
    this.connector = new Connector({
      url: options.url,
      credential: options.credential,
      paths: PATHS,
      subprotocol: SUBPROTOCOL,
      ...(options.maxRetryMs === undefined ? {} : { maxRetryMs: options.maxRetryMs }),
    });
  }

  /** The close code with which the core ended the channel for good. */
  get ended(): number | undefined {
    return this.connector.ended;
  }

  async open(): Promise<void> {
    await this.client.connect(
      new StreamableHTTPClientTransport(this.connector.requestUrl, { fetch: this.connector.fetch }),
    );
    await this.connector.connect((channel) => this.server.connect(new ChannelTransport(channel)));
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.client.close(), this.connector.close()]);
  }
}

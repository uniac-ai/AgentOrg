/**
 * The human actor's connection to the core, as the root: an `ActorConnection` that dials `/mcp`
 * as the root's client and `/mcp/reverse` as the server of the human's tools. Until the core first
 * answers, it dials again; once open, the connection redials the reverse socket after any loss.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type CallToolResult, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { ActorConnection } from "../bindings/mcp/legacy-actor-connection.ts";

/** The core did not answer, or refused the root credential. */
export class CoreUnreachable extends Error {}

const MAX_PAUSE_MS = 10_000;

export class Core {
  readonly url: string;
  #connection: ActorConnection | undefined;
  #closed = false;

  constructor(url: string, credential: string, server: Server) {
    this.url = url;
    void this.#open(credential, server);
  }

  /** The tools available to the root. */
  async tools(): Promise<Tool[]> {
    return this.#use(async (connection) => (await connection.client.listTools()).tools);
  }

  /** Call a tool available to the root; a refusal comes back as an error result. */
  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.#use(
      (connection) =>
        connection.client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    );
  }

  async close() {
    this.#closed = true;
    await this.#connection?.close();
  }

  async #open(credential: string, server: Server) {
    for (let pause = 250; !this.#closed; pause = Math.min(pause * 2, MAX_PAUSE_MS)) {
      const connection = new ActorConnection({
        url: this.url,
        credential,
        server,
        name: "agentorg-human",
      });
      try {
        await connection.open();
        if (this.#closed) await connection.close();
        else this.#connection = connection;
        return;
      } catch {
        await connection.close();
        await new Promise((resolve) => setTimeout(resolve, pause).unref());
      }
    }
  }

  async #use<T>(work: (connection: ActorConnection) => Promise<T>): Promise<T> {
    const connection = this.#connection;
    try {
      if (connection === undefined) throw new Error("not connected yet");
      return await work(connection);
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new CoreUnreachable(`the core is not reachable at ${this.url}`, { cause: error });
    }
  }
}

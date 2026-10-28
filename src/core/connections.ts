/**
 * The connection layer: it turns a credential into an actor, holds each actor's reverse connection
 * as an MCP client, and keeps the actor's online state and exposed tools in the registry current.
 *
 * An actor has at most one reverse connection; a newer one replaces it. The actor is online from
 * the moment its tools are listed until the connection ends. Each time an actor comes online the
 * layer calls `onOnline`, which the core binds to redelivery, so nothing here knows about calls.
 * A tunnel or a remote network can replace this module without touching routing.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  CLOSE_ACTOR_CLOSED,
  CLOSE_REPLACED,
  type FrameSocket,
  WebSocketTransport,
} from "../protocol/index.ts";
import { VERSION } from "../version.ts";
import type { ActorRecord, Registry } from "./registry.ts";

/** An exposed tool's own name: no dots, since dots join handles and tool names. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

interface Peer {
  client: Client;
  transport: WebSocketTransport;
}

export class Connections {
  private readonly registry: Registry;
  private readonly peers = new Map<string, Peer>();
  /** Bound by the core; called with the actor's id each time it comes online. */
  onOnline: (actor: string) => void = () => {};
  /** Bound by the core; called when an actor's reverse connection fails to start. */
  onError: (actor: string, error: Error) => void = () => {};

  constructor(registry: Registry) {
    this.registry = registry;
  }

  /** The open actor whose credential this is. */
  identify(credential: string): ActorRecord | undefined {
    return this.registry.byCredential(credential);
  }

  /** The MCP client of the actor's reverse connection, while the actor is online. */
  peer(actor: string): Client | undefined {
    return this.peers.get(actor)?.client;
  }

  /**
   * Take an actor's accepted WebSocket and return the transport its owner feeds. The core then
   * initializes as the client, lists the actor's tools and marks it online.
   */
  accept(actor: string, socket: FrameSocket): WebSocketTransport {
    const transport = new WebSocketTransport(socket);
    void this.attach(actor, transport);
    return transport;
  }

  private async attach(actor: string, transport: WebSocketTransport): Promise<void> {
    const client = new Client({ name: "agentorg-core", version: VERSION });
    const peer = { client, transport };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (this.peers.get(actor) === peer) await this.listTools(actor, client).catch(() => {});
    });
    try {
      await client.connect(transport);
      const previous = this.peers.get(actor);
      this.peers.set(actor, peer);
      client.onclose = () => {
        if (this.peers.get(actor) !== peer) return;
        this.peers.delete(actor);
        this.registry.setOnline(actor, false);
      };
      await previous?.transport.close(CLOSE_REPLACED, "replaced by a newer connection");
      await this.listTools(actor, client);
    } catch (error) {
      this.onError(actor, error as Error);
      await transport.close();
      return;
    }
    if (this.peers.get(actor) !== peer) return;
    this.registry.setOnline(actor, true);
    this.onOnline(actor);
  }

  /** Read every page of the actor's tools into the registry, keeping those with valid names. */
  private async listTools(actor: string, client: Client): Promise<void> {
    const tools = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor });
      tools.push(...page.tools.filter((tool) => TOOL_NAME.test(tool.name)));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    this.registry.setTools(actor, tools);
  }

  /** End a closed actor's reverse connection. */
  async disconnect(actor: string): Promise<void> {
    await this.peers.get(actor)?.transport.close(CLOSE_ACTOR_CLOSED, "the actor was closed");
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.peers.values()].map((peer) => peer.transport.close()));
  }
}

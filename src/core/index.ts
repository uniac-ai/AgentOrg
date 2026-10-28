/**
 * The core: it manages the organization's actors, their credentials and connections, the wiring
 * of who calls whom, the routing and records of calls, and the audit trail, and holds no UI. Its
 * only surface is the protocol's two endpoints (`src/protocol/`).
 *
 * - `registry.ts`: the actors, the tree they form, and their credentials.
 * - `connections.ts`: the connection layer, from a credential to an actor's reverse MCP client,
 *   its online state and its exposed tools.
 * - `wiring.ts`: whose tools each actor may call, under what names.
 * - `calls.ts`: call records, delivery and redelivery, MCP tasks, and waits.
 * - `builtins.ts` and `tools.ts`: the built-ins, and each actor's available tools on `/mcp`.
 * - `audit.ts`: the audit trail.
 * - `mcp.ts` and `app.ts`: the endpoints, `/mcp` and `/mcp/reverse`.
 * - `store.ts` and `schema.ts`: SQLite storage of the records.
 */

import { existsSync } from "node:fs";
import type { Hono } from "hono";
import { readPrivate, writePrivate } from "../home.ts";
import type { CoreEnv } from "./access.ts";
import { createApp } from "./app.ts";
import { Audit } from "./audit.ts";
import { builtins } from "./builtins.ts";
import { Calls } from "./calls.ts";
import { Connections } from "./connections.ts";
import { Registry } from "./registry.ts";
import type { Store } from "./store.ts";
import { AvailableTools, type Timing } from "./tools.ts";

export interface CoreOptions extends Partial<Timing> {
  now?: () => Date;
  /** How long a call into a tool without task support may take. */
  timeoutMs?: number;
}

export class Core {
  readonly store: Store;
  readonly registry: Registry;
  readonly connections: Connections;
  readonly calls: Calls;
  readonly audit: Audit;
  readonly app: Hono<CoreEnv>;

  constructor(store: Store, options: CoreOptions = {}) {
    const clock = options.now ?? (() => new Date());
    const now = () => clock().toISOString();
    this.store = store;
    this.registry = new Registry(store, now);
    this.registry.setAllOffline();
    this.audit = new Audit(store, now);
    this.connections = new Connections(this.registry);
    this.calls = new Calls(store, this.registry, this.connections, this.audit, {
      now,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    this.connections.onOnline = (actor) => this.calls.redeliver(actor);
    const handlers = builtins(store, this.registry, this.connections, this.calls, this.audit, now);
    const tools = new AvailableTools(this.registry, this.calls, handlers, this.audit, {
      waitMs: options.waitMs ?? 30_000,
      stepMs: options.stepMs ?? 10_000,
    });
    this.app = createApp(this.connections, tools);
  }

  async close(): Promise<void> {
    await this.connections.closeAll();
  }
}

/**
 * The root's credential, kept in `file`: written with the root on the first start, and minted
 * again when the file is gone, since only its hash is stored.
 */
export function rootCredential(registry: Registry, file: string): string {
  const root = registry.root();
  if (!root) {
    const { credential } = registry.createRoot();
    writePrivate(file, credential);
    return credential;
  }
  if (!existsSync(file)) {
    const credential = registry.rotateCredential(root.id);
    writePrivate(file, credential);
    return credential;
  }
  const credential = readPrivate(file);
  if (registry.byCredential(credential)?.id !== root.id) {
    throw new Error(
      `${file} does not hold the root's credential; delete it and start the core again to mint a new one`,
    );
  }
  return credential;
}

/**
 * The core: it manages the organization's actors, their credentials and connections, and the audit
 * trail, and holds no UI. Its only surface is the protocol's two endpoints (`src/protocol/`).
 *
 * - `registry.ts`: the actors, the tree they form, and their credentials.
 * - `connections.ts`: the connection layer, from a credential to an actor's reverse MCP client,
 *   its online state and its exposed tools.
 * - `mcp.ts` and `app.ts`: the endpoints, `/mcp` and `/mcp/reverse`.
 * - `store.ts` and `schema.ts`: SQLite storage of the records.
 */

import { existsSync } from "node:fs";
import type { Hono } from "hono";
import { readPrivate, writePrivate } from "../home.ts";
import type { CoreEnv } from "./access.ts";
import { createApp } from "./app.ts";
import { Connections } from "./connections.ts";
import type { Surface } from "./mcp.ts";
import { Registry } from "./registry.ts";
import type { Store } from "./store.ts";

export interface CoreOptions {
  now?: () => Date;
}

/** The surface before routing: no tools. */
const NO_TOOLS: Surface = {
  tools: () => [],
  call: async (_actor, params) => ({
    content: [{ type: "text", text: `not_found: there is no tool ${params.name}` }],
    isError: true,
  }),
};

export class Core {
  readonly store: Store;
  readonly registry: Registry;
  readonly connections: Connections;
  readonly app: Hono<CoreEnv>;

  constructor(store: Store, options: CoreOptions = {}) {
    const now = options.now ?? (() => new Date());
    this.store = store;
    this.registry = new Registry(store, () => now().toISOString());
    this.registry.setAllOffline();
    this.connections = new Connections(this.registry);
    this.app = createApp(this.connections, NO_TOOLS);
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

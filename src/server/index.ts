/**
 * The core process's composition root, the one place the layers meet: the domain over its store,
 * served in MCP through the network's listener.
 *
 * - `src/domain/`: the organization, its calls and its built-ins, behind ports.
 * - `src/storage/sqlite/`: the domain's store.
 * - `src/bindings/mcp/`: the domain's operations in MCP.
 * - `src/network/`: the listener, its access and its channels.
 */

import { existsSync } from "node:fs";
import { mcpEndpoints, PATHS } from "../bindings/mcp/index.ts";
import { Organization, type OrganizationOptions } from "../domain/index.ts";
import type { Store } from "../domain/ports.ts";
import type { Registry } from "../domain/registry.ts";
import { readPrivate, writePrivate } from "../home.ts";
import { listen } from "../network/index.ts";

export interface CoreOptions extends OrganizationOptions {
  /** How long a call into an interface that is not long-running may take. */
  timeoutMs?: number;
  onError?: (party: string, error: Error) => void;
}

export interface RunningCore {
  organization: Organization;
  url: string;
  /** End every actor's channel, as a lost network would. */
  drop(): void;
  close(): Promise<void>;
}

/** Serve the organization over `store` on 127.0.0.1 at `port`, 0 for a free one. */
export async function startCore(
  store: Store,
  options: CoreOptions & { port: number; hostname?: string },
): Promise<RunningCore> {
  const organization = new Organization(store, options);
  const listening = await listen({
    port: options.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    paths: PATHS,
    identities: organization,
    endpoints: mcpEndpoints(organization, {
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    }),
  });
  return { organization, url: listening.url, drop: listening.drop, close: listening.close };
}

/**
 * The root's credential, kept in `file`: written with the root on the first start, and minted
 * again when the file is gone, since only its hash is stored.
 */
export async function rootCredential(registry: Registry, file: string): Promise<string> {
  const root = registry.root();
  if (!root) {
    const { credential } = await registry.createRoot();
    writePrivate(file, credential);
    return credential;
  }
  if (!existsSync(file)) {
    const credential = await registry.rotateCredential(root.id);
    writePrivate(file, credential);
    return credential;
  }
  const credential = readPrivate(file);
  if ((await registry.byCredential(credential))?.id !== root.id) {
    throw new Error(
      `${file} does not hold the root's credential; delete it and start the core again to mint a new one`,
    );
  }
  return credential;
}

/**
 * The core process's composition root, the one place the layers meet: the domain over its store,
 * served in MCP through the network's listener.
 *
 * - `src/domain/`: the organization, its calls and its built-ins, behind ports.
 * - `src/storage/sqlite/`: the domain's store.
 * - `src/bindings/mcp/`: the domain's operations in MCP.
 * - `src/network/`: the listener and its channels.
 * - `src/connection/`: identity admission and immutable connection context.
 * - `src/provider/`: the fixed factory client on Provider-initiated connections.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { serveConnection } from "../bindings/mcp/index.ts";
import { accept, CONNECTION_PATH, type Principal } from "../connection/index.ts";
import {
  organization as createOrganization,
  type Organization,
  type OrganizationOptions,
} from "../domain/index.ts";
import type { Store } from "../domain/ports.ts";
import { type ProviderIdentity, providers } from "../domain/providers.ts";
import type { Registry } from "../domain/registry.ts";
import { readPrivate, writePrivate } from "../home.ts";
import { type Channel, CLOSE_REVOKED, listen } from "../network/index.ts";
import { ProviderClient } from "../provider/index.ts";

export interface CoreOptions extends OrganizationOptions {
  /** How long a call into an interface that is not long-running may take. */
  timeoutMs?: number;
  onError?: (party: string, error: Error) => void;
  providers?: readonly ProviderIdentity[];
  /** Explicit admission policy for omitted credentials; supplied credentials are always checked. */
  allowCredentialOmission?: (principal: Principal) => boolean;
}

export interface RunningCore {
  organization: Organization;
  /** Internal factory lookup; no lifetime Actor-to-executor association is kept. */
  provider(providerId: string): ProviderClient | undefined;
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
  const actorConnections = new Map<string, Set<Channel>>();
  const providerClients = new Map<string, ProviderClient>();
  const providerIdentities = providers(options.providers ?? []);
  const organization = createOrganization(store, {
    ...options,
    provider: (providerId) => providerClients.get(providerId),
    onActorClosed: (actorId) => {
      for (const channel of actorConnections.get(actorId) ?? [])
        channel.close(CLOSE_REVOKED, "the Actor was closed");
      options.onActorClosed?.(actorId);
    },
  });
  const listening = await listen({
    port: options.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    path: CONNECTION_PATH,
    channel: (channel) =>
      accept(
        channel,
        {
          admit: async (identity) => {
            if ("providerId" in identity) {
              return identity.credential === undefined
                ? providerIdentities.has(identity.providerId) &&
                    options.allowCredentialOmission?.({ providerId: identity.providerId }) === true
                : providerIdentities.admit(identity.providerId, identity.credential);
            }
            const authenticated =
              identity.credential === undefined
                ? options.allowCredentialOmission?.({ actorId: identity.actorId }) === true
                : (await organization.registry.byCredential(identity.credential))?.id ===
                  identity.actorId;
            const actor = organization.registry.get(identity.actorId);
            return authenticated && actor !== undefined && actor.closed_at === null;
          },
        },
        ({ principal, channel: admitted }) => {
          if ("providerId" in principal) {
            const client = new ProviderClient(admitted, { timeoutMs: options.timeoutMs ?? 60_000 });
            providerClients.set(principal.providerId, client);
            admitted.whenClosed(() => {
              if (providerClients.get(principal.providerId) === client)
                providerClients.delete(principal.providerId);
            });
          } else {
            const actorId = principal.actorId;
            if (organization.registry.get(actorId)?.closed_at !== null) {
              admitted.close(CLOSE_REVOKED, "the Actor was closed");
              return;
            }
            let connections = actorConnections.get(actorId);
            if (!connections) {
              connections = new Set();
              actorConnections.set(actorId, connections);
            }
            connections.add(admitted);
            admitted.whenClosed(() => {
              connections.delete(admitted);
              if (!connections.size) actorConnections.delete(actorId);
            });
            serveConnection(organization, actorId, admitted, {
              timeoutMs: options.timeoutMs ?? 60_000,
              ...(options.onError === undefined ? {} : { onError: options.onError }),
            });
          }
        },
      ),
  });
  return {
    organization,
    provider: (providerId: string) => providerClients.get(providerId),
    url: listening.url,
    drop: listening.drop,
    close: listening.close,
  };
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
    writePrivate(join(dirname(file), "root-actor"), registry.root()?.id ?? "");
    return credential;
  }
  if (!existsSync(file)) {
    const credential = await registry.rotateCredential(root.id);
    writePrivate(file, credential);
    writePrivate(join(dirname(file), "root-actor"), root.id);
    return credential;
  }
  const credential = readPrivate(file);
  if ((await registry.byCredential(credential))?.id !== root.id) {
    throw new Error(
      `${file} does not hold the root's credential; delete it and start the core again to mint a new one`,
    );
  }
  writePrivate(join(dirname(file), "root-actor"), root.id);
  return credential;
}

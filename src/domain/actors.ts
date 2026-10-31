/** Actor lifecycle and read projection over identity, provisioning and admitted connections. */

import type { Connections } from "./connections.ts";
import type { ExecutionClient } from "./execution.ts";
import { ACTORS } from "./model/index.ts";
import type { ActorRow, ActorView } from "./ports.ts";
import type { Registry } from "./registry.ts";
import { bindTool } from "./tools.ts";

export { ACTORS as definition } from "./model/index.ts";

export function actors(registry: Registry, connections: Connections, execution: ExecutionClient) {
  function view(actor: ActorRow): ActorView {
    const { credential_hash: _, ...identity } = actor;
    return {
      ...identity,
      path: registry.path(actor),
      online: connections.connected(actor.id),
    };
  }

  return {
    view,
    tool: bindTool(ACTORS, {
      actor_create: async (actor, request) => {
        const { actor: created, credential } = await registry.create(
          actor.id,
          request.name,
          request.purpose,
        );
        const outcome =
          request.execution === undefined
            ? undefined
            : await execution.create({
                actorId: created.id,
                credential,
                providerId: request.execution.providerId,
                config: request.execution.config,
              });
        return {
          actor: view(registry.found(created.id)),
          credential,
          ...(outcome === undefined ? {} : { execution: outcome }),
        };
      },
      actor_close: async (actor, request) => {
        const { actor: closed, changed } = registry.close(actor, request.actor);
        if (changed) connections.disconnect(closed.id);
        return { actor: view(closed) };
      },
    }),
  };
}

export type Actors = ReturnType<typeof actors>;

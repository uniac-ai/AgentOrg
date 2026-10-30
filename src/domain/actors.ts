/** Actor lifecycle and read projection over identity, execution, calls and connection owners. */

import type { Calls } from "./calls.ts";
import type { Connections } from "./connections.ts";
import type { ExecutionClient } from "./execution.ts";
import { ACTORS } from "./model/index.ts";
import type { ActorRow, ActorView } from "./ports.ts";
import type { Registry } from "./registry.ts";
import { bindTool } from "./tools.ts";

export { ACTORS as definition } from "./model/index.ts";

export function actors(
  registry: Registry,
  calls: Calls,
  connections: Connections,
  execution: ExecutionClient,
) {
  function view(actor: ActorRow): ActorView {
    const { credential_hash: _, ...identity } = actor;
    return {
      ...identity,
      path: registry.path(actor),
      online: connections.link(actor.id) !== undefined,
      interfaces: connections.interfaces(actor.id),
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
          request.created_at_attach,
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
        const ended = changed ? calls.endFor(closed, actor.id) : [];
        if (changed) await connections.disconnect(closed.id);
        return { actor: view(closed), ended_calls: ended };
      },
    }),
  };
}

export type Actors = ReturnType<typeof actors>;

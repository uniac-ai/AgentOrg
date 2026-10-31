/** Presence and revocation for admitted Actor connections, independently of any implementation. */

import type { ActorConnection } from "./ports.ts";

export function connections() {
  const active = new Map<string, Set<ActorConnection>>();
  return {
    connected: (actor: string) => (active.get(actor)?.size ?? 0) > 0,
    online(actor: string, connection: ActorConnection): void {
      const connections = active.get(actor) ?? new Set<ActorConnection>();
      connections.add(connection);
      active.set(actor, connections);
    },
    offline(actor: string, connection: ActorConnection): void {
      const connections = active.get(actor);
      connections?.delete(connection);
      if (connections?.size === 0) active.delete(actor);
    },
    disconnect(actor: string): void {
      const connections = active.get(actor);
      active.delete(actor);
      for (const connection of connections ?? []) connection.close();
    },
  };
}

export type Connections = ReturnType<typeof connections>;

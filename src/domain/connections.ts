/** The single inventory of admitted sockets, presence, local work and transport/lifecycle controls. */
import { Conflict } from "./errors.ts";
import type { ConnectionPrincipal } from "./model/system.ts";

export interface ConnectionControl {
  detach(): void;
  revoke(): void;
  pendingFactoryRequests?(): number;
  selectedForCreation?(): boolean;
}
export interface AdmittedConnection {
  connectionId: string;
  principal: ConnectionPrincipal;
  admittedAt: string;
  ordinal: number;
  state: "admitted" | "closing";
  activeInvocations: number;
  activeCreations: number;
  control: ConnectionControl;
}
export function connections(now: () => string) {
  const active = new Map<string, AdmittedConnection>();
  let head = 0;
  const found = (id: string) => {
    const entry = active.get(id);
    if (entry?.state !== "admitted") throw new Conflict("the connection is closing or ended");
    return entry;
  };
  return {
    admit(connectionId: string, principal: ConnectionPrincipal, control: ConnectionControl): void {
      if (active.has(connectionId)) throw new Conflict("the connection is already admitted");
      active.set(connectionId, {
        connectionId,
        principal: Object.freeze({ ...principal }),
        control,
        ordinal: ++head,
        admittedAt: now(),
        state: "admitted",
        activeInvocations: 0,
        activeCreations: 0,
      });
    },
    remove: (id: string) => {
      active.delete(id);
    },
    get: (id: string) => active.get(id),
    entries: () => [...active.values()],
    head: () => head,
    connected: (actorId: string) =>
      [...active.values()].some(
        (entry) =>
          entry.state === "admitted" &&
          "actorId" in entry.principal &&
          entry.principal.actorId === actorId,
      ),
    assertActor(id: string, actorId: string): void {
      const entry = found(id);
      if (!("actorId" in entry.principal) || entry.principal.actorId !== actorId)
        throw new Conflict("the connection does not carry this Actor");
    },
    beginInvocation(id: string, actorId: string): () => void {
      this.assertActor(id, actorId);
      const entry = found(id);
      entry.activeInvocations += 1;
      return () => {
        entry.activeInvocations -= 1;
      };
    },
    beginCreation(id: string): () => void {
      const entry = found(id);
      if (!("providerId" in entry.principal))
        throw new Conflict("the connection is not a Provider");
      entry.activeCreations += 1;
      return () => {
        entry.activeCreations -= 1;
      };
    },
    busy: (entry: AdmittedConnection) =>
      entry.activeInvocations > 0 ||
      entry.activeCreations > 0 ||
      (entry.control.pendingFactoryRequests?.() ?? 0) > 0,
    detach(id: string): void {
      const entry = found(id);
      if (this.busy(entry)) throw new Conflict("the connection has active Hub work");
      entry.state = "closing";
      entry.control.detach();
      active.delete(id);
    },
    disconnect(actorId: string): void {
      for (const entry of [...active.values()]) {
        if (!("actorId" in entry.principal) || entry.principal.actorId !== actorId) continue;
        entry.state = "closing";
        active.delete(entry.connectionId);
        entry.control.revoke();
      }
    },
  };
}
export type Connections = ReturnType<typeof connections>;

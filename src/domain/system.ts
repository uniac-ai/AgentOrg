/** Shared operational reads and single-socket detach under canonical Actor authority. */
import type { AdmittedConnection, Connections } from "./connections.ts";
import type { Diagnostics } from "./diagnostics.ts";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import { SYSTEM, type SystemConnection } from "./model/system.ts";
import type { ActorRow, Invocation } from "./ports.ts";
import type { Registry } from "./registry.ts";
import { bindTool } from "./tools.ts";

export interface SystemRuntime {
  version: string;
  nodeVersion: string;
  providerIds: readonly string[];
}
export function system(
  registry: Registry,
  connections: Connections,
  diagnostics: Diagnostics,
  now: () => string,
  runtime: SystemRuntime,
) {
  const instanceId = crypto.randomUUID();
  const startedAt = now();
  function position(query: { instanceId?: string; after: number }, head: number) {
    if (
      (query.instanceId !== undefined && query.instanceId !== instanceId) ||
      (query.after > 0 && query.instanceId === undefined)
    )
      throw new Conflict("the continuation belongs to another Hub run");
    if (query.after > head) throw new Invalid("after: beyond this run's position");
  }
  function blocked(
    actor: ActorRow,
    entry: AdmittedConnection,
    how: Invocation,
  ): SystemConnection["blockedBy"] {
    if (how.connectionId === undefined) return "forbidden";
    if (entry.connectionId === how.connectionId) return "current_connection";
    const root = registry.root()?.id === actor.id;
    const allowed =
      "actorId" in entry.principal
        ? root ||
          entry.principal.actorId === actor.id ||
          registry.get(entry.principal.actorId)?.manager === actor.id
        : root;
    if (!allowed) return "forbidden";
    if (entry.state === "closing") return "closing";
    if (connections.busy(entry)) return "busy";
    return undefined;
  }
  function view(actor: ActorRow, entry: AdmittedConnection, how: Invocation): SystemConnection {
    const blockedBy = blocked(actor, entry, how);
    return {
      connectionId: entry.connectionId,
      principal: { ...entry.principal },
      admittedAt: entry.admittedAt,
      state: entry.state,
      activeInvocations: entry.activeInvocations,
      canDisconnect: blockedBy === undefined,
      ...(blockedBy === undefined ? {} : { blockedBy }),
      ...("providerId" in entry.principal
        ? {
            pendingFactoryRequests: entry.control.pendingFactoryRequests?.() ?? 0,
            activeCreations: entry.activeCreations,
            selectedForCreation: entry.control.selectedForCreation?.() ?? false,
          }
        : {}),
    };
  }
  return bindTool(SYSTEM, {
    system_status: (_actor, request) => {
      const active = connections.entries().filter((entry) => entry.state === "admitted");
      return {
        instanceId,
        observedAt: now(),
        startedAt,
        version: runtime.version,
        nodeVersion: runtime.nodeVersion,
        state: "serving" as const,
        actorConnections: active.filter((entry) => "actorId" in entry.principal).length,
        providerConnections: active.filter((entry) => "providerId" in entry.principal).length,
        configuredProviders: runtime.providerIds.length,
        diagnostics: diagnostics.read(request.diagnosticLimit),
      };
    },
    connection_list: (actor, request, how) => {
      position(request, connections.head());
      const matches = connections
        .entries()
        .filter(
          (entry) =>
            entry.ordinal > request.after &&
            (request.connectionId === undefined || entry.connectionId === request.connectionId) &&
            (request.actorId === undefined ||
              ("actorId" in entry.principal && entry.principal.actorId === request.actorId)) &&
            (request.providerId === undefined ||
              ("providerId" in entry.principal &&
                entry.principal.providerId === request.providerId)),
        );
      const rows = matches.slice(0, request.limit);
      return {
        instanceId,
        observedAt: now(),
        items: rows.map((entry) => view(actor, entry, how)),
        after: rows.at(-1)?.ordinal ?? request.after,
        atEnd: matches.length <= request.limit,
      };
    },
    provider_list: (_actor, request) => {
      position(request, runtime.providerIds.length);
      const entries = connections.entries();
      const matches = runtime.providerIds
        .map((providerId, index) => {
          const sockets = entries.filter(
            (entry) =>
              entry.state === "admitted" &&
              "providerId" in entry.principal &&
              entry.principal.providerId === providerId,
          );
          return {
            ordinal: index + 1,
            providerId,
            admittedConnections: sockets.length,
            selectedConnectionId:
              sockets.find((entry) => entry.control.selectedForCreation?.())?.connectionId ?? null,
            activeCreations: sockets.reduce((sum, entry) => sum + entry.activeCreations, 0),
          };
        })
        .filter(
          (row) =>
            row.ordinal > request.after &&
            (request.providerId === undefined || row.providerId === request.providerId) &&
            (request.connected === undefined || row.admittedConnections > 0 === request.connected),
        );
      const rows = matches.slice(0, request.limit);
      return {
        instanceId,
        observedAt: now(),
        items: rows.map(({ ordinal: _, ...row }) => row),
        after: rows.at(-1)?.ordinal ?? request.after,
        atEnd: matches.length <= request.limit,
      };
    },
    connection_disconnect: (actor, request, how) => {
      if (request.instanceId !== instanceId)
        throw new Conflict("the connection belongs to another Hub run");
      if (how.connectionId === undefined)
        throw new Forbidden("an admitted calling connection is required");
      const entry = connections.get(request.connectionId);
      if (!entry) throw new NotFound("the connection is not admitted");
      const reason = blocked(actor, entry, how);
      if (reason === "forbidden") throw new Forbidden("the Actor does not control this connection");
      if (reason !== undefined) throw new Conflict(`connection disconnect refused: ${reason}`);
      connections.detach(request.connectionId);
      return { instanceId, connectionId: request.connectionId, closed: true as const };
    },
  });
}

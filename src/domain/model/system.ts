/** Shared operational observations and exact transient socket controls. */
import { z } from "zod";
import { toolDefinition } from "./json-schema.ts";
import { Id, Timestamp } from "./records.ts";

export const InstanceId = z.uuid();
export const privateOperation = (name: string) =>
  name === "message_send" || name === "message_get" || name === "message_list";
const ProviderId = z.string().min(1);
const Position = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Count = z.number().int().min(0);
export const ConnectionPrincipal = z.union([
  z.strictObject({ actorId: Id }),
  z.strictObject({ providerId: ProviderId }),
]);
export type ConnectionPrincipal = z.output<typeof ConnectionPrincipal>;
const PageInput = z.strictObject({
  instanceId: InstanceId.optional(),
  after: Position.default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export const ConnectionQuery = PageInput.extend({
  connectionId: InstanceId.optional(),
  actorId: Id.optional(),
  providerId: ProviderId.optional(),
});
export const ProviderQuery = PageInput.extend({
  providerId: ProviderId.optional(),
  connected: z.boolean().optional(),
});
const BlockedBy = z.enum(["current_connection", "forbidden", "busy", "closing"]);
export const SystemConnection = z.strictObject({
  connectionId: InstanceId,
  principal: ConnectionPrincipal,
  admittedAt: Timestamp,
  state: z.enum(["admitted", "closing"]),
  activeInvocations: Count,
  canDisconnect: z.boolean(),
  blockedBy: BlockedBy.optional(),
  pendingFactoryRequests: Count.optional(),
  activeCreations: Count.optional(),
  selectedForCreation: z.boolean().optional(),
});
export type SystemConnection = z.output<typeof SystemConnection>;
export const SystemProvider = z.strictObject({
  providerId: ProviderId,
  admittedConnections: Count,
  selectedConnectionId: InstanceId.nullable(),
  activeCreations: Count,
});
const page = <S extends z.ZodType>(item: S) =>
  z.strictObject({
    instanceId: InstanceId,
    observedAt: Timestamp,
    items: z.array(item),
    after: Position,
    atEnd: z.boolean(),
  });
export const ConnectionPage = page(SystemConnection);
export const ProviderPage = page(SystemProvider);
export const Diagnostic = z.strictObject({
  at: Timestamp,
  code: z.enum([
    "admission_refused",
    "admission_failed",
    "mcp_initialization_failed",
    "protocol_invalid",
    "provider_unavailable",
    "execution_failed",
    "execution_outcome_unknown",
    "operation_failed",
    "connection_closed",
  ]),
  stage: z.enum(["admission", "mcp", "invocation", "provider_creation", "transport"]),
  outcome: z.enum(["observed", "not_sent", "refused", "unknown"]),
  message: z.string().max(200),
  actorId: Id.optional(),
  providerId: ProviderId.optional(),
  connectionId: InstanceId.optional(),
  operation: z
    .string()
    .min(1)
    .max(64)
    .refine((name) => !privateOperation(name))
    .optional(),
  closeCode: z.number().int().min(0).max(65535).optional(),
});
export type Diagnostic = z.output<typeof Diagnostic>;
export const SystemStatus = z.strictObject({
  instanceId: InstanceId,
  observedAt: Timestamp,
  startedAt: Timestamp,
  version: z.string(),
  nodeVersion: z.string(),
  state: z.literal("serving"),
  actorConnections: Count,
  providerConnections: Count,
  configuredProviders: Count,
  diagnostics: z.strictObject({
    items: z.array(Diagnostic).max(100),
    capacity: z.literal(100),
    retained: Count.max(100),
    dropped: Count,
    scope: z.literal("this_run"),
  }),
});
export const ConnectionDisconnected = z.strictObject({
  instanceId: InstanceId,
  connectionId: InstanceId,
  closed: z.literal(true),
});
export const SYSTEM = toolDefinition("system", {
  system_status: {
    writes: false,
    level: "organization",
    request: z.strictObject({ diagnosticLimit: z.number().int().min(1).max(100).default(20) }),
    response: SystemStatus,
    description:
      "Observe this answering Hub run and its bounded fixed-code diagnostics. Connection presence and local work counts do not establish native health or idleness. Private Message operations produce no diagnostic events.",
  },
  connection_list: {
    writes: false,
    level: "organization",
    request: ConnectionQuery,
    response: ConnectionPage,
    description:
      "Inspect admitted Hub sockets matching all supplied criteria before the limit. Continuations belong to the same run, caller and filters; refresh from zero for current membership. No remote-worker health is inferred.",
  },
  provider_list: {
    writes: false,
    level: "organization",
    request: ProviderQuery,
    response: ProviderPage,
    description:
      "Inspect configured Provider identities, admitted socket counts and selected factory routes. Presence is not responsiveness, execution readiness or native health.",
  },
  connection_disconnect: {
    writes: true,
    level: "organization",
    request: z.strictObject({ instanceId: InstanceId, connectionId: InstanceId }),
    response: ConnectionDisconnected,
    description:
      "Detach one exact Hub socket with transient close code 1000. Refused for the calling socket or observed local work. Actor authority is self's other socket, direct manager or root; Provider authority is canonical root. Clients may reconnect; this neither stops native work nor revokes identity. Never retry an unknown outcome blindly.",
  },
});

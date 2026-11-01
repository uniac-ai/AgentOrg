/** Public wire schemas and types for clients; definitions belong to the domain model. */

export {
  Actor as DirectoryActor,
  Field,
  Form,
  Message,
  Review,
  Status,
  Submission,
  Work,
  WorkStatus,
} from "@uniac/agentic-workspace/contracts";
export { ActorClosed, BUILTINS } from "../domain/model/builtins.ts";
export { Claim } from "../domain/model/claims.ts";
export type { Answer, InterfaceDescriptor, ToolDescriptor } from "../domain/model/index.ts";
export { Actor, AuditEntry } from "../domain/model/records.ts";
export {
  ConnectionDisconnected,
  ConnectionPage,
  Diagnostic,
  ProviderPage,
  SystemConnection,
  SystemProvider,
  SystemStatus,
} from "../domain/model/system.ts";
export { Position, Team } from "../domain/model/team.ts";

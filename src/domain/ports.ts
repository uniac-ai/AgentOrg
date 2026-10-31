/** The domain's protocol, connection and storage boundaries. */

import type { WorkspaceStore } from "@uniac/agentic-workspace/persistence";
import type { z } from "zod";
import type {
  Actor,
  ActorRecord,
  Answer,
  AuditEntry,
  Call,
  Claim,
  ToolDescriptor,
} from "./model/index.ts";

export type ActorRow = z.output<typeof ActorRecord>;
export type CallRow = z.output<typeof Call>;
export type AuditRow = z.output<typeof AuditEntry>;
export type ClaimRow = z.output<typeof Claim>;

/** Revocation of one admitted Actor connection. */
export interface ActorConnection {
  close(): void;
}

export interface Invocation {
  /** Tell the caller the call is still running. */
  progress(message: string): Promise<void>;
  /** Aborted when the caller goes away. */
  signal: AbortSignal;
}

/** What an actor may do: its Tools and their interfaces, and calling one by its alias. */
export interface Application {
  available(actor: string): ToolDescriptor[];
  invoke(
    actor: string,
    name: string,
    input: Record<string, unknown>,
    how: Invocation,
  ): Promise<Answer>;
}

/** The record reads and writes the domain needs, whatever keeps them. */
export interface Store {
  workspace: WorkspaceStore;
  actors: {
    insert(actor: ActorRow): void;
    update(actor: ActorRow): void;
    get(id: string): ActorRow | undefined;
    /** The open actor with this credential hash. */
    byCredentialHash(hash: string): ActorRow | undefined;
    root(): ActorRow | undefined;
    /** Open direct reports, oldest first. */
    reports(manager: string): ActorRow[];
    /** Every open actor, oldest first, so managers come before their reports. */
    open(): ActorRow[];
    /** Active directory rows in stable insertion order, with the canonical high-water mark. */
    directory(after: number, limit: number): { items: ActorRow[]; after: number; head: number };
  };
  calls: {
    get(id: string): CallRow | undefined;
  };
  claims: {
    get(resource: string): ClaimRow | undefined;
    /** Hold the resource, replacing the claim it had. */
    put(claim: ClaimRow): void;
    remove(resource: string): void;
  };
  audit: {
    append(entry: Omit<AuditRow, "id">): void;
    /** Entries after `since`, newest first. */
    list(since: number | undefined, limit: number): AuditRow[];
  };
  /** Run `work` so that its writes land together or not at all. */
  transaction<T>(work: () => T): T;
}

export type ActorView = z.output<typeof Actor>;

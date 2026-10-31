/** The domain's protocol, connection and storage boundaries. */

import type { z } from "zod";
import type {
  Actor,
  ActorRecord,
  Answer,
  AuditEntry,
  Call,
  Claim,
  Message,
  Progress,
  Question,
  ToolDescriptor,
} from "./model/index.ts";

export type ActorRow = z.output<typeof ActorRecord>;
export type CallRow = z.output<typeof Call>;
export type AuditRow = z.output<typeof AuditEntry>;
export type ProgressRow = z.output<typeof Progress>;
export type QuestionRow = z.output<typeof Question>;
export type MessageRow = z.output<typeof Message>;
export type ClaimRow = z.output<typeof Claim>;
export type AnswerRow = NonNullable<QuestionRow["answer"]>;

/** Which questions to list: those matching every field given, newest first. */
export interface QuestionQuery {
  to?: string;
  from?: string;
  /** Not answered yet. */
  open?: boolean;
  /** With a cursor after this one. */
  since?: number;
  limit?: number;
}

/** Which messages to list: those matching every field given, newest first. */
export interface MessageQuery {
  /**
   * Who reads them: those with a party that is the viewer or one of its reports. Null reads
   * every message, as the root does.
   */
  viewer: string | null;
  to?: string;
  from?: string;
  unread?: boolean;
  /** With a cursor after this one. */
  since?: number;
  limit?: number;
}

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

/** Context for a request waiting on domain state. */
export interface Waiting {
  stepMs: number;
  progress: () => Promise<void>;
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
  };
  calls: {
    get(id: string): CallRow | undefined;
  };
  progress: {
    insert(progress: ProgressRow): void;
    /** The actor's versions, newest first. */
    latest(actor: string, limit: number): ProgressRow[];
  };
  questions: {
    insert(question: QuestionRow): void;
    get(id: string): QuestionRow | undefined;
    list(query: QuestionQuery): QuestionRow[];
    /** Record an open question's answer, moving it to `cursor`. */
    answer(id: string, answer: AnswerRow, cursor: number): void;
  };
  messages: {
    insert(message: MessageRow): void;
    get(id: string): MessageRow | undefined;
    list(query: MessageQuery): MessageRow[];
    /** Mark those not yet read as read now. */
    read(ids: string[], at: string): void;
  };
  /** The newest cursor of the sequence questions and messages share; 0 before either. */
  head(): number;
  claims: {
    get(resource: string): ClaimRow | undefined;
    /** Hold the resource, replacing the claim it had. */
    put(claim: ClaimRow): void;
    remove(resource: string): void;
    heldBy(actor: string): ClaimRow[];
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

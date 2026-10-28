/**
 * The domain's ports: the interfaces through which it meets the layers around it. A protocol
 * binding implements `ActorLink` and drives `Presence` and `Application`; a storage layer
 * implements `Store`. The domain implements `Presence` and `Application` itself.
 */

import type { z } from "zod";
import type {
  Actor,
  ActorRecord,
  Answer,
  AuditEntry,
  Call,
  Delivery,
  InterfaceDescriptor,
  Message,
  Offer,
  Outcome,
  Progress,
} from "./model/index.ts";

export type ActorRow = z.output<typeof ActorRecord>;
export type CallRow = z.output<typeof Call>;
export type AuditRow = z.output<typeof AuditEntry>;
export type ProgressRow = z.output<typeof Progress>;
export type MessageRow = z.output<typeof Message>;

/** Which messages to list: those matching every field given, newest first. */
export interface MessageQuery {
  /**
   * Who reads them: only the public ones, and those with a party that is the viewer or one of its
   * reports. Null reads every message, as the root does.
   */
  viewer: string | null;
  to?: string;
  from?: string;
  /** Actors each of which is the sender or the addressee. */
  parties?: string[];
  /** Replies to this message. */
  replyTo?: string;
  /** Still pending on the addressee: a question until answered, any other message until read. */
  pending?: boolean;
  questions?: boolean;
  /** Sent after this time. */
  since?: string;
  limit?: number;
}

/** The way to one reachable actor, for as long as it is reachable. */
export interface ActorLink {
  /**
   * Hand the actor a call. A long-running one may come back as a run, finished later. The signal
   * aborts when the call is withdrawn before the actor answers.
   */
  deliver(delivery: Delivery, signal: AbortSignal): Promise<Outcome | { run: string }>;
  /** Wait until the actor finishes a run. */
  outcome(run: string, signal: AbortSignal): Promise<Outcome>;
  cancel(run: string): Promise<void>;
  /** End the link for good: the actor was closed. */
  close(): Promise<void>;
}

/** The link ended before the actor answered; the call waits for the actor to be back. */
export class LinkLost extends Error {}

/** The actor no longer knows the run, as after a restart; the call is delivered again. */
export class UnknownRun extends Error {}

/** Whether actors can be reached, as a binding learns it. */
export interface Presence {
  /** The actor can be called through `link`, and exposes `interfaces`. */
  online(actor: string, link: ActorLink, interfaces: InterfaceDescriptor[]): void;
  /** The actor behind `link` changed what it exposes. */
  changed(actor: string, link: ActorLink, interfaces: InterfaceDescriptor[]): void;
  offline(actor: string, link: ActorLink): void;
}

export interface Invocation {
  /** The call the caller is handling, recorded as the new call's cause. */
  cause: string | null;
  /** Tell the caller the call is still running. */
  progress(message: string): Promise<void>;
  /** Aborted when the caller goes away. */
  signal: AbortSignal;
}

/** What an actor may do: the interfaces it may call, and calling one. */
export interface Application {
  available(actor: string): Offer[];
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
    setOnline(id: string, online: boolean): void;
    setAllOffline(): void;
    setInterfaces(id: string, interfaces: InterfaceDescriptor[]): void;
  };
  calls: {
    insert(call: CallRow): void;
    get(id: string): CallRow | undefined;
    /** Pending calls into the actor, oldest first. */
    pendingTo(actor: string): CallRow[];
    /** Pending calls the actor made, oldest first. */
    pendingFrom(actor: string): CallRow[];
    /** Settled calls into or from the actor, newest first. */
    settled(actor: string, limit: number): CallRow[];
    /** Mark it handed to the actor now, with no run yet. */
    delivered(id: string, at: string): void;
    setRun(id: string, run: string): void;
    /** Settle a pending call; false when it was no longer pending. */
    settle(
      id: string,
      settled: Pick<CallRow, "state" | "output" | "error" | "settled_at">,
    ): boolean;
  };
  progress: {
    insert(progress: ProgressRow): void;
    /** The actor's versions, newest first. */
    latest(actor: string, limit: number): ProgressRow[];
  };
  messages: {
    insert(message: MessageRow): void;
    get(id: string): MessageRow | undefined;
    list(query: MessageQuery): MessageRow[];
    /** Mark those not yet read as read now. */
    read(ids: string[], at: string): void;
    /** Record the reply that answers an open question. */
    answer(question: string, reply: string): void;
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

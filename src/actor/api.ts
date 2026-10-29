/**
 * The actor library's API: what an actor exposes and how it calls. It names no protocol and no
 * network, so an actor written against it never meets either.
 */

import type { Answer, InterfaceDescriptor, Offer } from "../domain/model/index.ts";

/** A call into one of the actor's interfaces. */
export interface Incoming {
  id: string;
  /** The calling actor's id. */
  from: string;
  /** The call that led to this one, if the caller named it. */
  cause: string | null;
  /** Aborted when the caller withdraws the call. */
  signal: AbortSignal;
}

/** What a handler returns: a structured value, checked against the output schema, and parts. */
export interface Reply {
  value?: unknown;
  parts?: Record<string, unknown>[];
}

/**
 * An interface the actor exposes, with its handler. A long-running handler just returns a promise
 * that settles whenever it is ready, hours later if need be. A handler that throws fails the call.
 */
export interface Exposed {
  interface: InterfaceDescriptor;
  handle(input: Record<string, unknown>, call: Incoming): Promise<Reply>;
}

export interface CallOptions {
  /** The id of the call this actor is handling, recorded as the new call's cause. */
  cause?: string;
  progress?: (message: string) => void;
  timeoutMs?: number;
}

/** Context supplied by the client occupying an actor's position. */
export interface PresentationOptions extends Pick<CallOptions, "progress"> {
  /** The client's identity for this conversation, independent of the actor it fills. */
  session?: string;
}

/**
 * What an actor presents to whatever fills its position, such as an agent session: the interfaces
 * it offers there, and calling them.
 */
export interface Presented {
  /** What the occupant's client may tell its model about the offers as a whole. */
  readonly instructions?: string;
  offers(): Promise<Offer[]>;
  call(
    name: string,
    input: Record<string, unknown>,
    options?: PresentationOptions,
  ): Promise<Answer>;
  /** Call `listener` whenever the offers change. */
  onChange(listener: () => void): void;
}

export interface Actor {
  /** The interfaces available to this actor: the core's built-ins and those it is wired to. */
  available(): Promise<Offer[]>;
  call(name: string, input?: Record<string, unknown>, options?: CallOptions): Promise<Answer>;
  /** Replace what this actor exposes; the core reads it again. */
  expose(exposed: Exposed[]): Promise<void>;
  /** The close code with which the core ended this actor's connection for good. */
  readonly ended: number | undefined;
  close(): Promise<void>;
}

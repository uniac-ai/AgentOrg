/**
 * The Actor library's API: the Hub Tools an Actor receives and calls. It names no protocol and no
 * network, so an actor written against it never meets either.
 */

import type { Answer, ToolDescriptor } from "../domain/model/index.ts";

export type { ToolDescriptor } from "../domain/model/index.ts";

export interface CallOptions {
  progress?: (message: string) => void;
  timeoutMs?: number;
}

/** Context supplied by the client occupying an actor's position. */
export interface PresentationOptions extends Pick<CallOptions, "progress"> {
  /** The client's identity for this conversation, independent of the actor it fills. */
  session?: string;
}

/**
 * What an actor presents to whatever fills its position: its Tools and calling their interfaces.
 */
export interface Presented {
  /** What the occupant's client may tell its model about the offers as a whole. */
  readonly instructions?: string;
  offers(): Promise<ToolDescriptor[]>;
  call(
    name: string,
    input: Record<string, unknown>,
    options?: PresentationOptions,
  ): Promise<Answer>;
  /** Call `listener` whenever the offers change. */
  onChange(listener: () => void): void;
}

export interface Actor {
  /** The Tools available to this actor, each with its local interfaces and callable aliases. */
  available(): Promise<ToolDescriptor[]>;
  call(name: string, input?: Record<string, unknown>, options?: CallOptions): Promise<Answer>;
  /** The close code with which the core ended this actor's connection for good. */
  readonly ended: number | undefined;
  close(): Promise<void>;
}

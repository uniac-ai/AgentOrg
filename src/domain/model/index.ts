/**
 * The domain's vocabulary, which actors may import too: the records, the interface descriptor,
 * the built-ins' schemas, the communication standard's records and requests, and the shapes of a
 * delivery, its outcome and a caller's answer.
 */

import type { z } from "zod";
import type { Interface } from "./records.ts";

export * from "./builtins.ts";
export * from "./communication.ts";
export * from "./json-schema.ts";
export * from "./records.ts";

export type InterfaceDescriptor = z.output<typeof Interface>;

/** A call as the called actor receives it. */
export interface Delivery {
  call: string;
  from: string;
  cause: string | null;
  interface: string;
  input: Record<string, unknown>;
  long_running: boolean;
}

/** What a called actor's interface returned. */
export type Outcome =
  | { ok: true; value: unknown; parts: Record<string, unknown>[] }
  | { ok: false; error: string };

/** An interface offered to an actor: a built-in, or another actor's under its routed name. */
export interface Offer {
  interface: InterfaceDescriptor;
  routed: boolean;
  /** A built-in that only reads. */
  read_only?: boolean;
}

/**
 * What a caller gets back. A built-in's answer has no parts: its value is the whole result. A
 * routed call's names the call.
 */
export type Answer =
  | { state: "done"; call?: string; value: unknown; parts?: Record<string, unknown>[] }
  | { state: "pending"; call: string }
  | { state: "failed"; call?: string; error: string }
  | { state: "withdrawn"; call: string }
  | { state: "refused"; code: string; message: string };

/** What the human actor's API under `/api` returns; the web app imports these types. */

import type { z } from "zod";
import type { ActorClosed as ActorClosedResult, View } from "../protocol/builtins.ts";
import type { Actor, AuditEntry, Call } from "../protocol/records.ts";
import type { InputOf, ToolName } from "./tools.ts";

/** A call waiting on the user, as the core delivered it to one of the human's tools. */
export type Pending = {
  [T in ToolName]: {
    /** The call's id at the core. */
    call: string;
    /** The calling actor's id. */
    from: string;
    /** The call that led to this one, if the caller named it. */
    cause: string | null;
    tool: T;
    input: InputOf<T>;
    received_at: string;
  };
}[ToolName];

/** `GET /api/pending`: the calls waiting on the user, oldest first. */
export interface PendingList {
  pending: Pending[];
}

/** `GET /api/session`: the sign-in session the cookie names, with the token every write carries. */
export interface SessionBootstrap {
  csrf_token: string;
  expires_at: string;
}

/** The header every write carries, holding the session's CSRF token. */
export const CSRF_HEADER = "X-CSRF-Token";

/**
 * The body of every error from `/api`: `signed_out` means the session is gone, `core_unreachable`
 * that the human actor cannot reach the core, and `refused` that the core refused a call.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
}

/** The core's records, as `view` and `activity` pass them through. */
export type ActorRecord = z.output<typeof Actor>;
export type CallRecord = z.output<typeof Call>;
export type ViewRecord = z.output<typeof View>;
export type AuditRecord = z.output<typeof AuditEntry>;
export type ActorClosed = z.output<typeof ActorClosedResult>;

/** What the human actor's API under `/api` returns; the web app imports these types. */

import type { z } from "zod";
import type {
  Actor,
  ActorClosed as ActorClosedResult,
  AuditEntry,
  BUILTINS,
  COMMUNICATION,
  Item,
  Link,
  Message,
  Offer,
  Position,
  Progress,
  Question,
  QuestionAnswer,
  WaitsOn,
} from "../domain/model/index.ts";

/** `GET /api/session`: the sign-in session the cookie names, with the token every write carries. */
export interface SessionBootstrap {
  csrf_token: string;
  expires_at: string;
}

/** `GET /api/interfaces`: the root's available interfaces, as the core offers them. */
export interface InterfaceList {
  interfaces: Offer[];
}

/** The header every write carries, holding the session's CSRF token. */
export const CSRF_HEADER = "X-CSRF-Token";

/**
 * The body of every error from `/api`: `signed_out` means the session is gone, `core_unreachable`
 * that the human actor cannot reach the core, `refused` that the core refused a call, and `failed`
 * or `withdrawn` how a call ended without a value.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
}

/** The core's records, as its built-ins return them. */
export type ActorRecord = z.output<typeof Actor>;
export type AuditRecord = z.output<typeof AuditEntry>;
export type ActorClosed = z.output<typeof ActorClosedResult>;
export type PositionRecord = z.output<typeof Position>;
export type ProgressRecord = z.output<typeof Progress>;
export type ItemRecord = z.output<typeof Item>;
export type LinkRecord = z.output<typeof Link>;
export type WaitsOnRecord = z.output<typeof WaitsOn>;
export type MessageRecord = z.output<typeof Message>;
export type QuestionRecord = z.output<typeof Question>;
export type AnswerRecord = z.output<typeof QuestionAnswer>;

type Specs = typeof BUILTINS & typeof COMMUNICATION;

/** Each built-in: its input, as a caller writes it, and its result. */
export type Builtins = {
  [N in keyof Specs]: {
    input: z.input<Specs[N]["request"]>;
    result: z.output<Specs[N]["response"]>;
  };
};

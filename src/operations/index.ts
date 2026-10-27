/**
 * The service layer's interface: every operation as a method, the caller, and the errors.
 *
 * `Operations` is derived from the contract's operation table, so an operation added there is a
 * method here. The API, MCP and the page all call the service through it.
 */

import type { z } from "zod";
import type {
  Channel,
  OperationName,
  PageSession,
  RequestOf,
  ResponseOf,
} from "../contract/index.ts";

/** Who is calling, as the transport tells it. The acting session is in the request itself. */
export interface Caller {
  readonly channel: z.output<typeof Channel>;
  readonly client?: string | undefined;
  readonly clientSessionId?: string | undefined;
}

export type Operations = {
  readonly [N in OperationName]: (request: RequestOf<N>, caller: Caller) => Promise<ResponseOf<N>>;
};

/** The decisions page's sign-in, which only the page uses. */
export interface PageSignIn {
  /** Use up a login link's token and start a page session; `Invalid` when unknown, used or expired. */
  redeemLoginToken(token: string): Promise<z.output<typeof PageSession>>;
  /** The page session with this id, or null when it is unknown or expired. */
  getPageSession(id: string): Promise<z.output<typeof PageSession> | null>;
}

export type Service = Operations & PageSignIn;

/** An operation refused its request. `code` is stable; the message is for the reader. */
export class OperationError extends Error {
  readonly code: string = "error";
}

export class NotFound extends OperationError {
  override readonly code = "not_found";
}

/** The request is well formed but breaks a rule of the record. */
export class Invalid extends OperationError {
  override readonly code = "invalid";
}

/** The acting session may not do this, such as answering an ask addressed to another agent. */
export class Forbidden extends OperationError {
  override readonly code = "forbidden";
}

/** The record's state does not allow it, such as answering an ask already answered. */
export class Conflict extends OperationError {
  override readonly code = "conflict";
}

/** An `Invalid` listing Zod's validation issues as `field: message`. */
export function invalid(issues: readonly z.core.$ZodIssue[]): Invalid {
  return new Invalid(
    issues
      .map((issue) => `${issue.path.map(String).join(".") || "request"}: ${issue.message}`)
      .join("; "),
  );
}

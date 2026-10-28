/** The refusals the core's tools return. `code` is stable; the message is for the reader. */

import type { z } from "zod";

export class Refusal extends Error {
  readonly code: string = "error";
}

export class NotFound extends Refusal {
  override readonly code = "not_found";
}

/** The request is well formed but breaks a rule of the records. */
export class Invalid extends Refusal {
  override readonly code = "invalid";
}

/** The caller may not do this, such as closing an actor it does not manage. */
export class Forbidden extends Refusal {
  override readonly code = "forbidden";
}

/** The records' state does not allow it, such as withdrawing a call already settled. */
export class Conflict extends Refusal {
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

/**
 * The audit trail: writes, interface refusals and preserved historical call outcomes. Only the
 * root reads it, since it names every Actor's operations, including who sent each private Message.
 */

import { Forbidden } from "./errors.ts";
import { ACTIVITY } from "./model/index.ts";
import type { AuditRow, Store } from "./ports.ts";
import { bindTool } from "./tools.ts";

export { ACTIVITY as definition } from "./model/index.ts";

export function audit(entries: Store["audit"], now: () => string) {
  function record(
    actor: string | null,
    operation: string,
    target: string | null,
    outcome: string,
  ): void {
    entries.append({ at: now(), actor, operation, target, outcome });
  }
  /** The latest entries, or the earliest after `since`; oldest first. */
  function list(since: number | undefined, limit: number): AuditRow[] {
    return entries.list(since, limit);
  }
  return {
    record,
    list,
    tool: bindTool(ACTIVITY, {
      activity: (actor, request) => {
        if (actor.manager !== null) throw new Forbidden("only the root reads the activity");
        return { entries: list(request.since, request.limit) };
      },
    }),
  };
}

export type Audit = ReturnType<typeof audit>;

/** The audit trail: writes, interface refusals and preserved historical call outcomes. */

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
  /** Entries after `since`, newest first. */
  function list(since: number | undefined, limit: number): AuditRow[] {
    return entries.list(since, limit);
  }
  return {
    record,
    list,
    tool: bindTool(ACTIVITY, {
      activity: (_actor, request) => ({ entries: list(request.since, request.limit) }),
    }),
  };
}

export type Audit = ReturnType<typeof audit>;

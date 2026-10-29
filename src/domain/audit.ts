/** The audit trail: one line per write and per routed call, with who acted, on what, and how. */

import type { AuditRow, Store } from "./ports.ts";

export function audit(entries: Store["audit"], now: () => string) {
  return {
    record(actor: string | null, operation: string, target: string | null, outcome: string): void {
      entries.append({ at: now(), actor, operation, target, outcome });
    },
    /** Entries after `since`, newest first. */
    list(since: number | undefined, limit: number): AuditRow[] {
      return entries.list(since, limit);
    },
  };
}

export type Audit = ReturnType<typeof audit>;

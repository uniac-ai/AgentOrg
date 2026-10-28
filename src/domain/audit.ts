/** The audit trail: one line per write and per routed call, with who acted, on what, and how. */

import type { AuditRow, Store } from "./ports.ts";

export class Audit {
  private readonly entries: Store["audit"];
  private readonly now: () => string;

  constructor(store: Store, now: () => string) {
    this.entries = store.audit;
    this.now = now;
  }

  record(actor: string | null, operation: string, target: string | null, outcome: string): void {
    this.entries.append({ at: this.now(), actor, operation, target, outcome });
  }

  /** Entries after `since`, newest first. */
  list(since: number | undefined, limit: number): AuditRow[] {
    return this.entries.list(since, limit);
  }
}

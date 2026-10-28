/** The audit trail: one line per write and per routed call, with who acted, on what, and how. */

import type { z } from "zod";
import type { AuditEntry } from "../protocol/index.ts";
import type { Store } from "./store.ts";

export class Audit {
  private readonly store: Store;
  private readonly now: () => string;

  constructor(store: Store, now: () => string) {
    this.store = store;
    this.now = now;
  }

  record(actor: string | null, operation: string, target: string | null, outcome: string): void {
    this.store.run(
      "INSERT INTO audit (at, actor, operation, target, outcome) VALUES (?, ?, ?, ?, ?)",
      [this.now(), actor, operation, target, outcome],
    );
  }

  /** Entries after `since`, newest first. */
  list(since: number | undefined, limit: number): z.output<typeof AuditEntry>[] {
    return this.store.select("audit", "id > ?", [since ?? 0], "id DESC", limit);
  }
}

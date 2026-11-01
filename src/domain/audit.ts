/**
 * The audit trail: writes, interface refusals and preserved historical call outcomes. Only the
 * root reads it, since it names every Actor's operations, including who sent each private Message.
 * Each entry wakes the reads waiting for the next one.
 */

import { Forbidden } from "./errors.ts";
import { ACTIVITY } from "./model/index.ts";
import type { AuditRow, Store } from "./ports.ts";
import { bindTool } from "./tools.ts";

export { ACTIVITY as definition } from "./model/index.ts";

export function audit(entries: Store["audit"], now: () => string) {
  const waiting = new Set<() => void>();
  function record(
    actor: string | null,
    operation: string,
    target: string | null,
    outcome: string,
  ): void {
    entries.append({ at: now(), actor, operation, target, outcome });
    for (const wake of [...waiting]) wake();
  }
  /** The latest entries, or the earliest after `since`; oldest first. */
  function list(since: number | undefined, limit: number): AuditRow[] {
    return entries.list(since, limit);
  }
  /** Resolves at the next entry, after `ms`, or when `signal` aborts, whichever comes first. */
  function next(signal: AbortSignal, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        waiting.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done);
      waiting.add(done);
      if (signal.aborted) done();
    });
  }
  return {
    record,
    list,
    next,
    head: () => list(undefined, 1)[0]?.id ?? 0,
    lastWrite: (actor: string) => entries.lastWrite(actor),
    tool: bindTool(ACTIVITY, {
      activity: (actor, request) => {
        if (actor.manager !== null) throw new Forbidden("only the root reads the activity");
        return { entries: list(request.since, request.limit) };
      },
    }),
  };
}

export type Audit = ReturnType<typeof audit>;

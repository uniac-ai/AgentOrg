// Progress as shapes and bars: a segmented bar of a subtree's states, and a row of state counts.

import { cn } from "@/lib/utils";
import type { Counts } from "../model/progress.ts";
import { PROGRESS_STATES, type ProgressState } from "../model/state.ts";
import { StateShape } from "./marks.tsx";

const FILLS: Record<ProgressState, string> = {
  running: "bg-state-running",
  review: "bg-state-review",
  waiting: "bg-state-waiting",
  blocked: "bg-state-blocked",
  idle: "bg-state-pending/70",
  closed: "bg-state-closed",
};

/** The counts in words, for assistive tech and the tooltip: "3 running, 1 blocked". */
export const countsInWords = (counts: Counts) =>
  PROGRESS_STATES.filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${state}`)
    .join(", ");

/** One segment per state, as wide as its count. */
export function RollupBar({ counts, className }: { counts: Counts; className?: string }) {
  const words = countsInWords(counts);
  return (
    <span
      title={words}
      className={cn("flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted", className)}
    >
      {PROGRESS_STATES.filter((state) => counts[state] > 0).map((state) => (
        <span
          key={state}
          aria-hidden="true"
          className={FILLS[state]}
          style={{ flexGrow: counts[state] }}
        />
      ))}
      <span className="sr-only">{words}</span>
    </span>
  );
}

/** Each state present, as its shape and its count. */
export function StateCounts({ counts }: { counts: Counts }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums">
      {PROGRESS_STATES.filter((state) => counts[state] > 0).map((state) => (
        <span key={state} title={state} className="inline-flex items-center gap-1">
          <StateShape state={state} />
          {counts[state]}
          <span className="sr-only"> {state}</span>
        </span>
      ))}
    </span>
  );
}

// Small marks that carry meaning by shape and color, each with a name for assistive tech.

import { PlugIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PositionRecord } from "../../../src/human/types.ts";
import { type ProgressState, progressState } from "../model/state.ts";

/** Each state's shape and color; a state is told apart by shape as well as color. */
export const SHAPES: Record<ProgressState, string> = {
  running: "rounded-full bg-state-running",
  waiting: "rounded-full bg-state-waiting",
  blocked: "rounded-[2px] bg-state-blocked",
  review: "rotate-45 rounded-[1px] bg-state-review",
  closed: "rounded-full bg-state-closed",
  idle: "rounded-full border-[1.5px] border-state-pending",
};

/** A state as a shape and a color, for assistive tech hidden; name it beside it where it matters. */
export function StateShape({ state, className }: { state: ProgressState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-3 shrink-0 items-center justify-center", className)}
    >
      <span className={cn("size-2", SHAPES[state])} />
    </span>
  );
}

type Standing = Pick<PositionRecord, "closed_at" | "progress">;

/** The member's state as a shape and a color; `StateName` says it to assistive tech. */
export const StateMark = ({ member, className }: { member: Standing; className?: string }) => (
  <StateShape state={progressState(member)} className={className} />
);

/** The member's state in words, for assistive tech, read after its name. */
export const StateName = ({ member }: { member: Standing }) => (
  <span className="sr-only">, {progressState(member)}</span>
);

export const SR = ({ children }: { children: string }) => (
  <span className="sr-only">{children}</span>
);

/** An actor whose connection to the core is open now; its title and accessible name say so. */
export function OnlineMark() {
  return (
    <span
      title="Online"
      className="inline-flex h-4 shrink-0 items-center rounded-[4px] bg-state-closed/15 px-1 text-state-closed"
    >
      <PlugIcon aria-hidden="true" className="size-2.5" />
      <span className="sr-only">online</span>
    </span>
  );
}

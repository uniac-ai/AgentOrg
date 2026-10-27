// Small marks that carry meaning by shape and color, each with a name for assistive tech.

import { cn } from "@/lib/utils";
import type { AgentRecord } from "../../../src/page/types.ts";

export type MarkState =
  | "running"
  | "waiting"
  | "blocked"
  | "review"
  | "pending"
  | "closed"
  | "idle";

/** What an agent's mark shows: its status once a session reports one, else its lifecycle. */
export function markState(agent: AgentRecord): MarkState {
  if (agent.state !== "active") return agent.state;
  return agent.status?.state ?? "idle";
}

const SHAPES: Record<MarkState, string> = {
  running: "rounded-full bg-state-running",
  waiting: "rounded-full bg-state-waiting",
  blocked: "rounded-[2px] bg-state-blocked",
  review: "rotate-45 rounded-[1px] bg-state-review",
  pending: "rounded-full border-[1.5px] border-dashed border-state-pending",
  closed: "rounded-full bg-state-closed",
  idle: "rounded-full border-[1.5px] border-state-pending",
};

/** The agent's state as a shape and a color; `StateName` says it to assistive tech. */
export function StateMark({ agent, className }: { agent: AgentRecord; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-3 shrink-0 items-center justify-center", className)}
    >
      <span className={cn("size-2", SHAPES[markState(agent)])} />
    </span>
  );
}

/** The agent's state in words, for assistive tech, read after its name. */
export const StateName = ({ agent }: { agent: AgentRecord }) => (
  <span className="sr-only">, {markState(agent)}</span>
);

export const SR = ({ children }: { children: string }) => (
  <span className="sr-only">{children}</span>
);

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

/** A state as a shape and a color, for assistive tech hidden; name it beside it where it matters. */
export function StateShape({ state, className }: { state: MarkState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-3 shrink-0 items-center justify-center", className)}
    >
      <span className={cn("size-2", SHAPES[state])} />
    </span>
  );
}

/** The agent's state as a shape and a color; `StateName` says it to assistive tech. */
export const StateMark = ({ agent, className }: { agent: AgentRecord; className?: string }) => (
  <StateShape state={markState(agent)} className={className} />
);

/** The agent's state in words, for assistive tech, read after its name. */
export const StateName = ({ agent }: { agent: AgentRecord }) => (
  <span className="sr-only">, {markState(agent)}</span>
);

export const SR = ({ children }: { children: string }) => (
  <span className="sr-only">{children}</span>
);

const CLIENTS: Record<string, { name: string; monogram: string }> = {
  "claude-code": { name: "Claude Code", monogram: "CC" },
  codex: { name: "Codex", monogram: "CX" },
};

/** A client kind's display name, such as "Claude Code"; an unknown kind is shown as given. */
export const clientName = (client: string) => CLIENTS[client]?.name ?? client;

/**
 * Which client a session runs in, as a two-letter monogram; `live` marks a session attached now.
 * Its title and accessible name give the client in full.
 */
export function ClientMark({ client, live = false }: { client: string; live?: boolean }) {
  const monogram = CLIENTS[client]?.monogram ?? client.replace(/[^a-z0-9]/gi, "").slice(0, 2);
  const name = `${clientName(client)}${live ? " session attached" : ""}`;
  return (
    <span
      title={name}
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-[4px] px-1 font-mono text-[10px] leading-none font-semibold uppercase",
        live ? "bg-state-closed/15 text-state-closed" : "bg-muted text-muted-foreground",
      )}
    >
      <span aria-hidden="true">{monogram}</span>
      <span className="sr-only">{name}</span>
    </span>
  );
}

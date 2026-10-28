// The organization below an entity: a strip of its totals and what changed lately, then the
// chart of the actors under it, each with its status in a line and, for a manager, a bar of its
// subtree's progress. It shows states and marks, not a stream of events.

import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, ClockAlertIcon, HistoryIcon, InboxIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ActorRecord } from "../../../src/human/types.ts";
import type { ChartNode } from "../control/entity.tsx";
import type { Counts } from "../model/progress.ts";
import { progressState } from "../model/state.ts";
import { OnlineMark, SR, StateMark, StateName } from "./marks.tsx";
import { RollupBar, StateCounts } from "./progress.tsx";
import { Ago } from "./time.tsx";

function Node({ node, depth }: { node: ChartNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const { actor } = node;
  const blocked = progressState(actor) === "blocked";
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-stretch gap-1">
        <Link
          data-row
          to="/people/$actorId"
          params={{ actorId: actor.id }}
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
            blocked && "border-state-blocked/50 bg-state-blocked/5",
            node.stale && "border-dashed",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <StateMark actor={actor} />
            <span className="truncate font-medium">{actor.name}</span>
            <StateName actor={actor} />
            {actor.online ? <OnlineMark /> : null}
            <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">
              {node.waitingOnYou > 0 ? (
                <span className="inline-flex items-center gap-0.5 rounded-md bg-primary px-1.5 py-0.5 font-medium text-primary-foreground tabular-nums">
                  <InboxIcon aria-hidden="true" className="size-3" />
                  {node.waitingOnYou}
                  <SR> waiting on you</SR>
                </span>
              ) : null}
              {node.waiting > 0 ? (
                <span className="rounded-md bg-state-waiting/15 px-1.5 py-0.5 font-medium text-state-waiting tabular-nums">
                  {node.waiting}
                  <SR> waiting on it</SR>
                </span>
              ) : null}
              {node.stale ? (
                <ClockAlertIcon
                  aria-label="Quiet for over an hour"
                  className="size-3.5 text-state-waiting"
                />
              ) : null}
              <span
                className={cn(
                  "tabular-nums",
                  node.stale ? "text-state-waiting" : "text-muted-foreground",
                )}
              >
                <SR>Last update </SR>
                <Ago at={actor.status?.updated_at ?? actor.created_at} />
              </span>
            </span>
          </span>
          {actor.status?.summary ? (
            <span className="truncate pl-5 text-sm text-muted-foreground">
              {actor.status.summary}
            </span>
          ) : null}
          {node.rollup ? <RollupBar counts={node.rollup} /> : null}
        </Link>
        {node.children.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${actor.name}: actors under it`}
            onClick={() => setOpen(!open)}
            className="flex w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn("size-4 transition-transform", open && "rotate-90")}
            />
          </button>
        ) : null}
      </div>
      {open && node.children.length > 0 ? <Nodes nodes={node.children} depth={depth + 1} /> : null}
    </li>
  );
}

function Nodes({ nodes, depth }: { nodes: ChartNode[]; depth: number }) {
  return (
    <ul className={cn("flex flex-col gap-1.5", depth > 0 && "ml-3 border-l pl-3 sm:ml-5 sm:pl-4")}>
      {nodes.map((node) => (
        <Node key={node.actor.id} node={node} depth={depth} />
      ))}
    </ul>
  );
}

/** The subtree's progress: its totals by state, and the actors in it that changed lately. */
export function ProgressStrip({ totals, recent }: { totals: Counts; recent: ActorRecord[] }) {
  return (
    <section aria-label="Progress" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <RollupBar counts={totals} className="h-2.5" />
      <StateCounts counts={totals} />
      {recent.length > 0 ? (
        <ul aria-label="Changed recently" className="flex flex-col gap-1 border-t pt-3">
          {recent.map((actor) => (
            <li key={actor.id}>
              <Link
                to="/people/$actorId"
                params={{ actorId: actor.id }}
                className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted"
              >
                <HistoryIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <StateMark actor={actor} />
                <span className="shrink-0 font-medium">{actor.name}</span>
                <StateName actor={actor} />
                <span className="min-w-0 truncate text-muted-foreground">
                  {actor.status?.summary}
                </span>
                {actor.status ? (
                  <Ago
                    at={actor.status.updated_at}
                    className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
                  />
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The actors below an entity, as a chart; the first level opens, deeper ones on request. */
export const Chart = ({ nodes }: { nodes: ChartNode[] }) => <Nodes nodes={nodes} depth={0} />;

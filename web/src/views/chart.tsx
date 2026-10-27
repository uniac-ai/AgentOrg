// The organization below an entity: a strip of its totals and what changed lately, then the
// chart of the agents under it, each with its status in a line and, for a manager, a bar of its
// subtree's progress. It shows states and marks, not a stream of events.

import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, ClockAlertIcon, HistoryIcon, InboxIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { AgentSummary } from "../../../src/page/types.ts";
import type { ChartNode } from "../control/entity.tsx";
import type { Counts } from "../model/progress.ts";
import { progressState } from "../model/state.ts";
import { ClientMark, SR, StateMark, StateName } from "./marks.tsx";
import { RollupBar, StateCounts } from "./progress.tsx";
import { Ago } from "./time.tsx";

function Node({ node, depth }: { node: ChartNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const { agent, asks_to_answer, unread_messages, attached_session, last_activity_at } =
    node.summary;
  const blocked = progressState(agent) === "blocked";
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-stretch gap-1">
        <Link
          data-row
          to="/people/$agentId"
          params={{ agentId: agent.id }}
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
            blocked && "border-state-blocked/50 bg-state-blocked/5",
            node.stale && "border-dashed",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <StateMark agent={agent} />
            <span className={cn("truncate", unread_messages > 0 ? "font-semibold" : "font-medium")}>
              {agent.title}
            </span>
            <StateName agent={agent} />
            {attached_session ? <ClientMark client={attached_session.client} live /> : null}
            <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">
              {node.waitingOnYou > 0 ? (
                <span className="inline-flex items-center gap-0.5 rounded-md bg-primary px-1.5 py-0.5 font-medium text-primary-foreground tabular-nums">
                  <InboxIcon aria-hidden="true" className="size-3" />
                  {node.waitingOnYou}
                  <SR> waiting on you</SR>
                </span>
              ) : null}
              {asks_to_answer > 0 ? (
                <span className="rounded-md bg-state-waiting/15 px-1.5 py-0.5 font-medium text-state-waiting tabular-nums">
                  {asks_to_answer}
                  <SR> asks to answer</SR>
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
                <SR>Last active </SR>
                <Ago at={last_activity_at} />
              </span>
            </span>
          </span>
          {agent.status?.summary ? (
            <span className="truncate pl-5 text-sm text-muted-foreground">
              {agent.status.summary}
            </span>
          ) : null}
          {node.rollup ? <RollupBar counts={node.rollup} /> : null}
        </Link>
        {node.children.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${agent.title}: agents under it`}
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
        <Node key={node.summary.agent.id} node={node} depth={depth} />
      ))}
    </ul>
  );
}

/** The subtree's progress: its totals by state, and the agents in it that changed lately. */
export function ProgressStrip({ totals, recent }: { totals: Counts; recent: AgentSummary[] }) {
  return (
    <section aria-label="Progress" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <RollupBar counts={totals} className="h-2.5" />
      <StateCounts counts={totals} />
      {recent.length > 0 ? (
        <ul aria-label="Changed recently" className="flex flex-col gap-1 border-t pt-3">
          {recent.map(({ agent }) => (
            <li key={agent.id}>
              <Link
                to="/people/$agentId"
                params={{ agentId: agent.id }}
                className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted"
              >
                <HistoryIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <StateMark agent={agent} />
                <span className="shrink-0 font-medium">{agent.title}</span>
                <StateName agent={agent} />
                <span className="min-w-0 truncate text-muted-foreground">
                  {agent.status?.summary}
                </span>
                {agent.status ? (
                  <Ago
                    at={agent.status.updated_at}
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

/** The agents below an entity, as a chart; the first level opens, deeper ones on request. */
export const Chart = ({ nodes }: { nodes: ChartNode[] }) => <Nodes nodes={nodes} depth={0} />;

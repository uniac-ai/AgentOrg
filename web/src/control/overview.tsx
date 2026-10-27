// The overview, control: the organization as a chart under the user, with each manager's
// subtree rolled up, blocked and stale agents marked, and where the user is waited on.

import { useQuery } from "@tanstack/react-query";
import type { AgentSummary } from "../../../src/page/types.ts";
import { agentsQuery, inboxQuery } from "../data/queries.ts";
import { type OrgNode, organization } from "../model/organization.ts";
import {
  type Counts,
  isStale,
  recentlyChanged,
  rollups,
  total,
  totals,
} from "../model/progress.ts";
import { OverviewView } from "../views/overview.tsx";
import { PaneSkeleton } from "../views/states.tsx";

export interface ChartNode {
  summary: AgentSummary;
  /** Its subtree by state, when it has agents under it. */
  rollup: Counts | undefined;
  stale: boolean;
  /** Its open asks addressed to the user. */
  waitingOnYou: number;
  children: ChartNode[];
}

export interface OverviewModel {
  totals: Counts;
  recent: AgentSummary[];
  inboxCount: number;
  chart: ChartNode[];
}

export function OverviewControl() {
  const agents = useQuery(agentsQuery);
  const inbox = useQuery(inboxQuery);
  if (!agents.data) return <PaneSkeleton />;
  const all = agents.data.agents;
  const subtrees = rollups(all);
  const asksToYou = new Map<string, number>();
  for (const ask of inbox.data?.asks ?? [])
    asksToYou.set(ask.agent, (asksToYou.get(ask.agent) ?? 0) + 1);
  const now = Date.now();
  const chart = (nodes: OrgNode[]): ChartNode[] =>
    nodes.map((node) => {
      const rollup = subtrees.get(node.summary.agent.id);
      return {
        summary: node.summary,
        rollup: rollup && total(rollup) > 0 ? rollup : undefined,
        stale: isStale(node.summary, now),
        waitingOnYou: asksToYou.get(node.summary.agent.id) ?? 0,
        children: chart(node.children),
      };
    });
  const model: OverviewModel = {
    totals: totals(all),
    recent: recentlyChanged(all),
    inboxCount: (inbox.data?.asks.length ?? 0) + (inbox.data?.messages.length ?? 0),
    chart: chart(organization(all)),
  };
  return <OverviewView {...model} />;
}

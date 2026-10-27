// Activity, control: every write on the record, newest first, with the agents and asks it names
// resolved for display, and each status set with its summary. The list starts at a page and
// grows on request.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { AgentRecord, AskRecord, PageActivity } from "../../../src/page/types.ts";
import { activityQuery, agentsQuery, allAsksQuery } from "../data/queries.ts";
import { ActivityView } from "../views/activity.tsx";
import { PaneSkeleton } from "../views/states.tsx";

const PAGE = 100;

export type ActivityEntry = PageActivity["entries"][number];

export interface ActivityModel {
  entries: ActivityEntry[];
  agents: ReadonlyMap<string, AgentRecord>;
  asks: ReadonlyMap<string, AskRecord>;
  /** Whether older entries may exist beyond those shown. */
  more: boolean;
  onShowMore: () => void;
}

export function ActivityControl() {
  const [limit, setLimit] = useState(PAGE);
  const activity = useQuery(activityQuery(limit));
  const agents = useQuery(agentsQuery);
  const asks = useQuery(allAsksQuery);
  if (!activity.data) return <PaneSkeleton />;
  const model: ActivityModel = {
    entries: activity.data.entries,
    agents: new Map(agents.data?.agents.map(({ agent }) => [agent.id, agent])),
    asks: new Map(asks.data?.asks.map((ask) => [ask.id, ask])),
    more: activity.data.more && limit < 1000,
    onShowMore: () => setLimit((current) => Math.min(1000, current + PAGE * 3)),
  };
  return <ActivityView {...model} />;
}

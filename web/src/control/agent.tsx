// An agent's pane, control: the agent with its presence, what waits on it, its recent work, and
// the ask open beside it. The feed starts short and grows only on request.

import { useQuery } from "@tanstack/react-query";
import { Outlet, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useRowKeys } from "@/lib/keys";
import type { AgentFull, AgentRecord, AgentSummary } from "../../../src/page/types.ts";
import { ApiError } from "../data/client.ts";
import { agentQuery, agentsQuery } from "../data/queries.ts";
import { type FeedEntry, feed, type Pending, pending } from "../model/activity.ts";
import { AgentView } from "../views/agent.tsx";
import { NotFoundView, PaneSkeleton } from "../views/states.tsx";

const FEED_START = 8;
const FEED_STEP = 20;

export interface AgentModel {
  detail: AgentFull;
  /** Presence and recency, from the organization's list. */
  summary: AgentSummary | undefined;
  agents: ReadonlyMap<string, AgentRecord>;
  pending: Pending;
  /** The newest entries of the feed shown so far. */
  feed: FeedEntry[];
  /** How many older entries are not shown yet. */
  more: number;
  onShowMore: () => void;
  openAsk: string | undefined;
  thread: React.ReactNode;
}

export function AgentControl() {
  const { agentId, askId } = useParams({ strict: false });
  const id = agentId ?? "";
  const agent = useQuery(agentQuery(id));
  const agents = useQuery(agentsQuery);
  const [shown, setShown] = useState(FEED_START);
  useRowKeys();

  // biome-ignore lint/correctness/useExhaustiveDependencies: another agent starts its feed short again.
  useEffect(() => setShown(FEED_START), [id]);

  if (agent.error instanceof ApiError && agent.error.status === 404) return <NotFoundView />;
  if (!agent.data) return <PaneSkeleton />;
  const entries = feed(agent.data);
  const model: AgentModel = {
    detail: agent.data,
    summary: agents.data?.agents.find((summary) => summary.agent.id === id),
    agents: new Map(agents.data?.agents.map((summary) => [summary.agent.id, summary.agent])),
    pending: pending(agent.data),
    feed: entries.slice(0, shown),
    more: Math.max(0, entries.length - shown),
    onShowMore: () => setShown((count) => count + FEED_STEP),
    openAsk: askId,
    thread: askId ? <Outlet /> : null,
  };
  return <AgentView {...model} />;
}

// An agent's pane, control: the agent with its presence, what waits on it, its recent work, and
// the ask open beside it. The feed starts short and grows only on request. Closing it is the
// user's to do here, once the agents under it are closed.

import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useRowKeys } from "@/lib/keys";
import type { AgentFull, AgentRecord, AgentSummary } from "../../../src/page/types.ts";
import { ApiError } from "../data/client.ts";
import { useCloseAgent } from "../data/mutations.ts";
import { agentQuery, agentsQuery } from "../data/queries.ts";
import { type FeedEntry, feed, type Pending, pending } from "../model/activity.ts";
import { AgentView } from "../views/agent.tsx";
import { notices } from "../views/notices.ts";
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
  /** The agents under it that are not closed; it may be closed only once there are none. */
  openChildren: AgentRecord[];
  /** Its own open asks, which closing withdraws. */
  openAsks: number;
  closing: boolean;
  onCloseAgent: () => void;
}

export function AgentControl() {
  const { agentId, askId } = useParams({ strict: false });
  const id = agentId ?? "";
  const agent = useQuery(agentQuery(id));
  const agents = useQuery(agentsQuery);
  const [shown, setShown] = useState(FEED_START);
  const close = useCloseAgent();
  const navigate = useNavigate();
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
    openChildren: (agents.data?.agents ?? [])
      .map((summary) => summary.agent)
      .filter((child) => child.manager === id && child.state !== "closed"),
    openAsks: agent.data.own_asks.filter((ask) => ask.state === "open").length,
    closing: close.isPending,
    onCloseAgent: () =>
      close.mutate(id, {
        onSuccess: (closed) => {
          notices.closed(closed);
          const manager = closed.agent.manager;
          void (manager === null
            ? navigate({ to: "/" })
            : navigate({ to: "/people/$agentId", params: { agentId: manager } }));
        },
        onError: notices.refused,
      }),
  };
  return <AgentView {...model} />;
}

// An entity's view, control, the same for the user and for every agent: what waits on it and from
// whom, its own asks going up, its reports below it with their progress, its manager, and its
// feed. Its data is the service's view of that entity, which an attaching agent gets as its facts.

import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useRowKeys } from "@/lib/keys";
import type {
  AgentRecord,
  AgentSummary,
  AskRecord,
  MessageRecord,
  EntityView as View,
} from "../../../src/page/types.ts";
import { ApiError } from "../data/client.ts";
import { useAcknowledge, useCloseAgent, useMarkRead } from "../data/mutations.ts";
import { agentsQuery, viewQuery } from "../data/queries.ts";
import { type FeedEntry, feed } from "../model/activity.ts";
import { below, flatten, type OrgNode, organization } from "../model/organization.ts";
import {
  type Counts,
  isStale,
  recentlyChanged,
  rollups,
  total,
  totals,
} from "../model/progress.ts";
import { EntityView } from "../views/entity.tsx";
import { notices } from "../views/notices.ts";
import { NotFoundView, PaneSkeleton } from "../views/states.tsx";

const FEED_START = 8;
const FEED_STEP = 20;

export interface ChartNode {
  summary: AgentSummary;
  /** Its subtree by state, when it has agents under it. */
  rollup: Counts | undefined;
  stale: boolean;
  /** Its open asks addressed to the user. */
  waitingOnYou: number;
  children: ChartNode[];
}

export interface EntityModel {
  /** The agent viewed; null is the user. */
  entity: AgentRecord | null;
  /** Its presence and recency, from the organization's list. */
  summary: AgentSummary | undefined;
  manager: AgentRecord | null;
  agents: ReadonlyMap<string, AgentRecord>;
  /** What waits on it: open asks addressed to it, then its unread notes and unreviewed reports. */
  pending: { asks: AskRecord[]; messages: MessageRecord[] };
  /** Its own open asks, going up to its manager. */
  ownAsks: AskRecord[];
  /** The organization below it: its totals, what changed lately, and the chart. */
  reports: { totals: Counts; recent: AgentSummary[]; chart: ChartNode[] };
  feed: FeedEntry[];
  /** Every session that attached to it, newest first; none for the user. */
  sessions: View["history"]["sessions"];
  /** How many older feed entries are not shown yet. */
  more: number;
  onShowMore: () => void;
  openAsk: string | undefined;
  thread: React.ReactNode;
  /** Settling a message: only for messages to the user, who is their recipient. */
  onAcknowledge: ((message: MessageRecord) => void) | undefined;
  onMarkRead: ((message: MessageRecord) => void) | undefined;
  /** Closing it, for an agent that is not closed. */
  close:
    | { openChildren: AgentRecord[]; openAsks: number; closing: boolean; onClose: () => void }
    | undefined;
}

function chart(nodes: OrgNode[], subtrees: Map<string, Counts>, asksToYou: Map<string, number>) {
  const now = Date.now();
  const build = (each: OrgNode[]): ChartNode[] =>
    each.map((node) => {
      const rollup = subtrees.get(node.summary.agent.id);
      return {
        summary: node.summary,
        rollup: rollup && total(rollup) > 0 ? rollup : undefined,
        stale: isStale(node.summary, now),
        waitingOnYou: asksToYou.get(node.summary.agent.id) ?? 0,
        children: build(node.children),
      };
    });
  return build(nodes);
}

export function EntityControl() {
  const { agentId, askId } = useParams({ strict: false });
  const entity = agentId ?? "user";
  const view = useQuery(viewQuery(entity));
  const user = useQuery(viewQuery("user"));
  const agents = useQuery(agentsQuery);
  const acknowledge = useAcknowledge();
  const markRead = useMarkRead();
  const close = useCloseAgent();
  const navigate = useNavigate();
  const [shown, setShown] = useState(FEED_START);
  useRowKeys();

  // biome-ignore lint/correctness/useExhaustiveDependencies: another entity starts its feed short again.
  useEffect(() => setShown(FEED_START), [entity]);

  if (view.error instanceof ApiError && view.error.status === 404) return <NotFoundView />;
  if (!view.data || !agents.data) return <PaneSkeleton />;
  const data: View = view.data;
  const all = agents.data.agents;
  const tree = below(organization(all), data.agent?.id ?? null);
  const asksToYou = new Map<string, number>();
  for (const ask of user.data?.asks_to_answer ?? []) {
    asksToYou.set(ask.agent, (asksToYou.get(ask.agent) ?? 0) + 1);
  }
  const subtrees = rollups(all);
  const id = data.agent?.id ?? null;
  const entries = feed(data);
  const isUser = data.agent === null;
  const model: EntityModel = {
    entity: data.agent,
    summary: all.find(({ agent }) => agent.id === data.agent?.id),
    manager: data.manager,
    agents: new Map(all.map(({ agent }) => [agent.id, agent])),
    pending: { asks: data.asks_to_answer, messages: data.inbox },
    ownAsks: data.own_asks.filter((ask) => ask.state === "open"),
    reports: {
      totals: id === null ? totals(all) : (subtrees.get(id) ?? totals([])),
      recent: recentlyChanged(flatten(tree)),
      chart: chart(tree, subtrees, asksToYou),
    },
    feed: entries.slice(0, shown),
    sessions: data.history.sessions,
    more: Math.max(0, entries.length - shown),
    onShowMore: () => setShown((count) => count + FEED_STEP),
    openAsk: askId,
    thread: askId ? <Outlet /> : null,
    onAcknowledge: isUser
      ? (message) =>
          acknowledge.mutate(message.id, {
            onSuccess: () => notices.acknowledged(message),
            onError: notices.refused,
          })
      : undefined,
    onMarkRead: isUser
      ? (message) =>
          markRead.mutate(message.id, {
            onSuccess: () => notices.read(message),
            onError: notices.refused,
          })
      : undefined,
    close:
      data.agent && data.agent.state !== "closed"
        ? {
            openChildren: data.children,
            openAsks: data.own_asks.filter((ask) => ask.state === "open").length,
            closing: close.isPending,
            onClose: () =>
              close.mutate(entity, {
                onSuccess: (closed) => {
                  notices.closed(closed);
                  const manager = closed.agent.manager;
                  void (manager === null
                    ? navigate({ to: "/" })
                    : navigate({ to: "/people/$agentId", params: { agentId: manager } }));
                },
                onError: notices.refused,
              }),
          }
        : undefined,
  };
  return <EntityView {...model} />;
}

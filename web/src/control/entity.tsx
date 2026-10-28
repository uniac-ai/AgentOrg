// An entity's view, control, the same for the user and for every actor: what waits on it and from
// whom, its own calls going out, its reports with their progress, its manager, and its feed. Its
// data is the core's `view` of that actor; the user is the root.

import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useRowKeys } from "@/lib/keys";
import type { ActorRecord, CallRecord, ViewRecord } from "../../../src/human/types.ts";
import { ApiError } from "../data/client.ts";
import { useAnswer, useCloseActor } from "../data/mutations.ts";
import { organizationQuery, viewQuery } from "../data/queries.ts";
import { type FeedEntry, feed } from "../model/activity.ts";
import { actors, flatten, type Organization, type OrgNode, tree } from "../model/organization.ts";
import {
  type Counts,
  isStale,
  recentlyChanged,
  rollups,
  total,
  totals,
} from "../model/progress.ts";
import type { Names } from "../views/calls.tsx";
import { EntityView } from "../views/entity.tsx";
import { notices } from "../views/notices.ts";
import { NotFoundView, PaneSkeleton } from "../views/states.tsx";

const FEED_START = 8;
const FEED_STEP = 20;

export interface ChartNode {
  actor: ActorRecord;
  /** Calls waiting on it. */
  waiting: number;
  /** Its subtree by state, when it has actors under it. */
  rollup: Counts | undefined;
  stale: boolean;
  /** Its calls waiting on the user. */
  waitingOnYou: number;
  children: ChartNode[];
}

export interface EntityModel {
  /** The actor viewed; null is the user. */
  entity: ActorRecord | null;
  /** Its manager; null is the user. */
  manager: ActorRecord | null;
  actors: ReadonlyMap<string, ActorRecord>;
  /** Each actor's name by id, the user's as "you". */
  names: Names;
  /** Calls waiting on it, oldest first. */
  pending: CallRecord[];
  /** Its own calls still waiting on another actor. */
  openCalls: CallRecord[];
  /** The organization below it: its totals, what changed lately, and the chart. */
  reports: { totals: Counts; recent: ActorRecord[]; chart: ChartNode[] };
  feed: FeedEntry[];
  /** How many older feed entries are not shown yet. */
  more: number;
  onShowMore: () => void;
  openCall: string | undefined;
  thread: React.ReactNode;
  /** Settling a note or a report: only for calls into the user. */
  onSettle: ((call: CallRecord) => void) | undefined;
  /** Closing it, for an actor that is not closed. */
  close:
    | { openReports: ActorRecord[]; openCalls: number; closing: boolean; onClose: () => void }
    | undefined;
}

function chart(nodes: OrgNode[], subtrees: Map<string, Counts>, root: ViewRecord | undefined) {
  const now = Date.now();
  const build = (each: OrgNode[]): ChartNode[] =>
    each.map((node) => {
      const actor = node.view.actor;
      const rollup = subtrees.get(actor.id);
      return {
        actor,
        waiting: node.view.pending.length,
        rollup: rollup && total(rollup) > 0 ? rollup : undefined,
        stale: isStale(actor, now),
        waitingOnYou: root?.pending.filter((call) => call.from === actor.id).length ?? 0,
        children: build(node.children),
      };
    });
  return build(nodes);
}

/** Each known actor's name, the root's as "you", then the paths the view names. */
export function namesOf(organization: Organization, view?: ViewRecord): Names {
  const names = new Map(Object.entries(view?.names ?? {}));
  for (const actor of actors(organization).values()) names.set(actor.id, actor.name);
  names.set(organization.root, "you");
  return names;
}

export function EntityControl() {
  const { actorId, callId } = useParams({ strict: false });
  const view = useQuery(viewQuery(actorId ?? "root"));
  const organization = useQuery(organizationQuery);
  const answer = useAnswer();
  const close = useCloseActor();
  const navigate = useNavigate();
  const [shown, setShown] = useState(FEED_START);
  useRowKeys();

  // biome-ignore lint/correctness/useExhaustiveDependencies: another entity starts its feed short again.
  useEffect(() => setShown(FEED_START), [actorId]);

  if (view.error instanceof ApiError && view.error.status === 400) return <NotFoundView />;
  if (!view.data || !organization.data) return <PaneSkeleton />;
  const data = view.data;
  const org = organization.data;
  const isYou = data.actor.id === org.root;
  const known = actors(org);
  known.set(data.actor.id, data.actor);
  const all = flatten(tree(org));
  const below = tree(org, data.actor.id);
  const subtrees = rollups(all);
  const entries = feed(data);
  const model: EntityModel = {
    entity: isYou ? null : data.actor,
    manager: data.manager && data.manager.id !== org.root ? data.manager : null,
    actors: known,
    names: namesOf(org, data),
    pending: data.pending,
    openCalls: data.open_calls,
    reports: {
      totals: isYou ? totals(all) : (subtrees.get(data.actor.id) ?? totals([])),
      recent: recentlyChanged(flatten(below)),
      chart: chart(below, subtrees, org.views[org.root]),
    },
    feed: entries.slice(0, shown),
    more: Math.max(0, entries.length - shown),
    onShowMore: () => setShown((count) => count + FEED_STEP),
    openCall: callId,
    thread: callId ? <Outlet /> : null,
    onSettle: isYou
      ? (call) => {
          const output = call.interface === "report" ? { acknowledged: true } : {};
          answer.mutate(
            { call: call.id, output },
            { onSuccess: () => notices.answered(call, output), onError: notices.refused },
          );
        }
      : undefined,
    close:
      !isYou && data.actor.closed_at === null
        ? {
            openReports: data.reports,
            openCalls: data.open_calls.length + data.pending.length,
            closing: close.isPending,
            onClose: () =>
              close.mutate(data.actor.id, {
                onSuccess: (closed) => {
                  notices.closed(closed);
                  const manager = closed.actor.manager;
                  void (manager === null || manager === org.root
                    ? navigate({ to: "/" })
                    : navigate({ to: "/people/$actorId", params: { actorId: manager } }));
                },
                onError: notices.refused,
              }),
          }
        : undefined,
  };
  return <EntityView {...model} />;
}

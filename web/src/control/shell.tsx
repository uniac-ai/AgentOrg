// The app shell's control: who is signed in, the organization, and where the user is. It renders
// the whole-app states or the shell view, with the route's pane inside.

import { useQueries } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useKeys } from "@/lib/keys";
import type { AgentRecord } from "../../../src/page/types.ts";
import { isSignedOut } from "../data/client.ts";
import { agentsQuery, inboxQuery, sessionQuery } from "../data/queries.ts";
import { managers, type OrgNode, organization } from "../model/organization.ts";
import { ShellView } from "../views/shell.tsx";
import { PaneSkeleton, SignedOutView, UnreachableView } from "../views/states.tsx";

/** Where the user is, for the sidebar's selection and the path above the pane. */
export type Place = { view: "inbox" } | { view: "agent"; id: string } | { view: "other" };

export interface ShellModel {
  /** Undefined until the organization first loads. */
  organization: OrgNode[] | undefined;
  inboxCount: number;
  /** The service stopped answering after the page loaded; what shows may be stale. */
  offline: boolean;
  place: Place;
  /** The managers above the agent in view, outermost first. */
  path: AgentRecord[];
  pane: React.ReactNode;
}

export function ShellControl() {
  const [session, agents, inbox] = useQueries({
    queries: [sessionQuery, agentsQuery, inboxQuery],
  });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { agentId } = useParams({ strict: false });
  const queries = [session, agents, inbox];
  const navigate = useNavigate();
  const tree = agents.data ? organization(agents.data.agents) : undefined;

  // ⌥↑ and ⌥↓ step through the sidebar: your own pane first, then every agent in tree order.
  useKeys((event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return false;
    const order = [undefined, ...flatten(tree ?? [])];
    const at = order.indexOf(agentId);
    const next =
      order[Math.min(order.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next === undefined) void navigate({ to: "/inbox" });
    else void navigate({ to: "/people/$agentId", params: { agentId: next } });
    return true;
  });

  if (queries.some((query) => isSignedOut(query.error))) return <SignedOutView />;
  if (queries.some((query) => query.isError && query.data === undefined)) {
    return <UnreachableView onRetry={() => queries.forEach((query) => void query.refetch())} />;
  }
  const byId = new Map(agents.data?.agents.map(({ agent }) => [agent.id, agent]));
  const place: Place =
    agentId !== undefined
      ? { view: "agent", id: agentId }
      : pathname.startsWith("/inbox")
        ? { view: "inbox" }
        : { view: "other" };
  const model: ShellModel = {
    organization: tree,
    inboxCount: (inbox.data?.asks.length ?? 0) + (inbox.data?.messages.length ?? 0),
    offline: queries.some((query) => query.isError),
    place,
    path: place.view === "agent" ? managers(place.id, byId) : [],
    pane: session.data ? <Outlet /> : <PaneSkeleton />,
  };
  return <ShellView {...model} />;
}

/** The agents' ids in the order the sidebar shows them. */
const flatten = (nodes: OrgNode[]): string[] =>
  nodes.flatMap((node) => [node.summary.agent.id, ...flatten(node.children)]);

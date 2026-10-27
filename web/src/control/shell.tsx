// The app shell's control: who is signed in, the organization, and where the user is. It renders
// the whole-app states or the shell view, with the route's pane inside.

import { useQueries } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useKeys } from "@/lib/keys";
import type { AgentRecord } from "../../../src/page/types.ts";
import { isSignedOut } from "../data/client.ts";
import { agentsQuery, sessionQuery, viewQuery } from "../data/queries.ts";
import { managers, type OrgNode, organization } from "../model/organization.ts";
import { ShellView } from "../views/shell.tsx";
import { PaneSkeleton, SignedOutView, UnreachableView } from "../views/states.tsx";
import { PaletteControl } from "./palette.tsx";

/** Where the user is, for the sidebar's selection and the path above the pane. */
export type Place =
  | { view: "you" }
  | { view: "activity" }
  | { view: "agent"; id: string }
  | { view: "other" };

export interface ShellModel {
  /** Undefined until the organization first loads. */
  organization: OrgNode[] | undefined;
  /** What waits on the user, for the user's entry in the sidebar. */
  waitingOnYou: number;
  /** The service stopped answering after the page loaded; what shows may be stale. */
  offline: boolean;
  place: Place;
  /** The managers above the agent in view, outermost first. */
  path: AgentRecord[];
  pane: React.ReactNode;
}

export function ShellControl() {
  const [session, agents, you] = useQueries({
    queries: [sessionQuery, agentsQuery, viewQuery("user")],
  });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { agentId } = useParams({ strict: false });
  const queries = [session, agents, you];
  const navigate = useNavigate();
  const tree = agents.data ? organization(agents.data.agents) : undefined;

  // ⌥↑ and ⌥↓ step through the sidebar: your own view first, then every agent in tree order.
  useKeys((event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return false;
    const order = [undefined, ...flatten(tree ?? [])];
    const at = order.indexOf(agentId);
    const next =
      order[Math.min(order.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next === undefined) void navigate({ to: "/" });
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
      : pathname === "/activity"
        ? { view: "activity" }
        : pathname === "/" || pathname.startsWith("/asks/")
          ? { view: "you" }
          : { view: "other" };
  const model: ShellModel = {
    organization: tree,
    waitingOnYou: (you.data?.asks_to_answer.length ?? 0) + (you.data?.inbox.length ?? 0),
    offline: queries.some((query) => query.isError),
    place,
    path: place.view === "agent" ? managers(place.id, byId) : [],
    pane: session.data ? (
      <>
        <Outlet />
        <PaletteControl />
      </>
    ) : (
      <PaneSkeleton />
    ),
  };
  return <ShellView {...model} />;
}

/** The agents' ids in the order the sidebar shows them. */
const flatten = (nodes: OrgNode[]): string[] =>
  nodes.flatMap((node) => [node.summary.agent.id, ...flatten(node.children)]);

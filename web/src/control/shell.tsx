// The app shell's control: who is signed in, the organization, and where the user is. It renders
// the whole-app states or the shell view, with the route's pane inside.

import { useQueries } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useKeys } from "@/lib/keys";
import type { ActorRecord } from "../../../src/human/types.ts";
import { isSignedOut } from "../data/client.ts";
import { organizationQuery, sessionQuery } from "../data/queries.ts";
import { actors, flatten, managers, type OrgNode, tree } from "../model/organization.ts";
import { ShellView } from "../views/shell.tsx";
import { PaneSkeleton, SignedOutView, UnreachableView } from "../views/states.tsx";
import { PaletteControl } from "./palette.tsx";

/** Where the user is, for the sidebar's selection and the path above the pane. */
export type Place =
  | { view: "you" }
  | { view: "activity" }
  | { view: "actor"; id: string }
  | { view: "other" };

export interface ShellModel {
  /** Undefined until the organization first loads. */
  organization: OrgNode[] | undefined;
  /** What waits on the user, for the user's entry in the sidebar. */
  waitingOnYou: number;
  /** The human actor stopped answering after the app loaded; what shows may be stale. */
  offline: boolean;
  place: Place;
  /** The managers above the actor in view, outermost first. */
  path: ActorRecord[];
  pane: React.ReactNode;
}

export function ShellControl() {
  const [session, organization] = useQueries({ queries: [sessionQuery, organizationQuery] });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { actorId } = useParams({ strict: false });
  const queries = [session, organization];
  const navigate = useNavigate();
  const nodes = organization.data ? tree(organization.data) : undefined;

  // ⌥↑ and ⌥↓ step through the sidebar: your own view first, then every actor in tree order.
  useKeys((event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return false;
    const order = [undefined, ...flatten(nodes ?? []).map((actor) => actor.id)];
    const at = order.indexOf(actorId);
    const next =
      order[Math.min(order.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next === undefined) void navigate({ to: "/" });
    else void navigate({ to: "/people/$actorId", params: { actorId: next } });
    return true;
  });

  if (queries.some((query) => isSignedOut(query.error))) return <SignedOutView />;
  if (queries.some((query) => query.isError && query.data === undefined)) {
    return <UnreachableView onRetry={() => queries.forEach((query) => void query.refetch())} />;
  }
  const place: Place =
    actorId !== undefined
      ? { view: "actor", id: actorId }
      : pathname === "/activity"
        ? { view: "activity" }
        : pathname === "/" || pathname.startsWith("/calls/")
          ? { view: "you" }
          : { view: "other" };
  const model: ShellModel = {
    organization: nodes,
    waitingOnYou: organization.data?.views[organization.data.root]?.pending.length ?? 0,
    offline: queries.some((query) => query.isError),
    place,
    path:
      place.view === "actor" && organization.data
        ? managers(place.id, actors(organization.data))
        : [],
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

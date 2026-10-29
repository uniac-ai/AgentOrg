// The app shell's control: who is signed in, the organization from the root's team, what waits
// on the user, and where the user is. It renders the whole-app states or the shell view, with the
// route's pane inside.

import { useQueries } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useKeys } from "@/lib/keys";
import { isSignedOut } from "../data/client.ts";
import { organizationQuery, questionsToQuery, sessionQuery, unreadQuery } from "../data/queries.ts";
import { questionsForYou } from "../model/messages.ts";
import { flatten, type Member, managers, openQuestions, waitingOn } from "../model/organization.ts";
import { ShellView } from "../views/shell.tsx";
import { PaneSkeleton, SignedOutView, UnreachableView } from "../views/states.tsx";
import { PaletteControl } from "./palette.tsx";

/** Where the user is, for the sidebar's selection and the path above the pane. */
export type Place =
  | { view: "you" }
  | { view: "activity" }
  | { view: "actor"; id: string; name: string | undefined }
  | { view: "other" };

export interface SidebarNode {
  member: Member;
  /** Open questions waiting on it. */
  waiting: number;
  children: SidebarNode[];
}

export interface ShellModel {
  /** Undefined until the organization first loads. */
  organization: SidebarNode[] | undefined;
  /** What waits on the user, for the user's entry in the sidebar. */
  waitingOnYou: number;
  /** The web client stopped answering after the app loaded; what shows may be stale. */
  offline: boolean;
  place: Place;
  /** The managers above the actor in view, outermost first. */
  path: Member[];
  pane: React.ReactNode;
}

export function ShellControl() {
  const [session, organization, unread] = useQueries({
    queries: [sessionQuery, organizationQuery, unreadQuery],
  });
  const [toYou] = useQueries({ queries: [questionsToQuery(organization.data?.root.id)] });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { actorId } = useParams({ strict: false });
  const queries = [session, organization, unread];
  const navigate = useNavigate();
  const org = organization.data;

  // ⌥↑ and ⌥↓ step through the sidebar: your own page first, then every actor in tree order.
  useKeys((event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return false;
    const order = [undefined, ...flatten(org?.root.reports ?? []).map((each) => each.id)];
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
      ? { view: "actor", id: actorId, name: org?.members.get(actorId)?.name }
      : pathname === "/activity"
        ? { view: "activity" }
        : pathname === "/"
          ? { view: "you" }
          : { view: "other" };
  const sidebar = (members: Member[]): SidebarNode[] =>
    members.map((member) => ({
      member,
      waiting: org ? waitingOn(member.id, org).length : 0,
      children: sidebar(member.reports),
    }));
  const model: ShellModel = {
    organization: org ? sidebar(org.root.reports) : undefined,
    waitingOnYou:
      org && toYou.data && unread.data
        ? questionsForYou(toYou.data, openQuestions(org), org.root.id).length + unread.data.length
        : 0,
    offline: queries.some((query) => query.isError),
    place,
    path: place.view === "actor" && org ? managers(place.id, org.members) : [],
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

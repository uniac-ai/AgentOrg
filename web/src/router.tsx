// Every view has a URL. The service serves the app's index.html on each of these paths
// (src/page/index.ts, APP_PATHS), and this router picks the view. Each entity, the user at `/`
// and every agent at `/people/:id`, has the same view, with an open ask beside it.

import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { ActivityControl } from "./control/activity.tsx";
import { EntityControl } from "./control/entity.tsx";
import { ShellControl } from "./control/shell.tsx";
import { ThreadControl } from "./control/thread.tsx";
import { NotFoundView } from "./views/states.tsx";

const root = createRootRoute({ component: ShellControl, notFoundComponent: NotFoundView });

// The user's view holds `/` and its threads; an index route takes no children, so it is a layout.
const you = createRoute({ getParentRoute: () => root, id: "you", component: EntityControl });

const yourView = createRoute({ getParentRoute: () => you, path: "/" });

const yourThread = createRoute({
  getParentRoute: () => you,
  path: "asks/$askId",
  component: ThreadControl,
});

const person = createRoute({
  getParentRoute: () => root,
  path: "/people/$agentId",
  component: EntityControl,
});

const personThread = createRoute({
  getParentRoute: () => person,
  path: "asks/$askId",
  component: ThreadControl,
});

const activity = createRoute({
  getParentRoute: () => root,
  path: "/activity",
  component: ActivityControl,
});

/** The inbox became the user's own view; its old links still land there. */
const inbox = createRoute({
  getParentRoute: () => root,
  path: "/inbox",
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});

const inboxThread = createRoute({
  getParentRoute: () => root,
  path: "/inbox/asks/$askId",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/asks/$askId", params: { askId: params.askId } });
  },
});

export const router = createRouter({
  routeTree: root.addChildren([
    you.addChildren([yourView, yourThread]),
    person.addChildren([personThread]),
    activity,
    inbox,
    inboxThread,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

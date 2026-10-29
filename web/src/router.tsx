// Every view has a URL. The web client serves the app's index.html on each of these paths
// (src/clients/web/web.ts, APP_PATHS), and this router picks the view: the user's page at `/`, every
// actor's at `/people/:id`, and the activity.

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { ActivityControl } from "./control/activity.tsx";
import { ActorControl } from "./control/actor.tsx";
import { ShellControl } from "./control/shell.tsx";
import { YouControl } from "./control/you.tsx";
import { NotFoundView } from "./views/states.tsx";

const root = createRootRoute({ component: ShellControl, notFoundComponent: NotFoundView });

const you = createRoute({ getParentRoute: () => root, path: "/", component: YouControl });

const actor = createRoute({
  getParentRoute: () => root,
  path: "/people/$actorId",
  component: ActorControl,
});

const activity = createRoute({
  getParentRoute: () => root,
  path: "/activity",
  component: ActivityControl,
});

export const router = createRouter({ routeTree: root.addChildren([you, actor, activity]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

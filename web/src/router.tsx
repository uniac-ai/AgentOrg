// Every view has a URL. The human actor serves the app's index.html on each of these paths
// (src/human/web.ts, APP_PATHS), and this router picks the view. Each entity, the user at `/`
// and every actor at `/people/:id`, has the same view, with a call open beside it.

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
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
  path: "calls/$callId",
  component: ThreadControl,
});

const person = createRoute({
  getParentRoute: () => root,
  path: "/people/$actorId",
  component: EntityControl,
});

const personThread = createRoute({
  getParentRoute: () => person,
  path: "calls/$callId",
  component: ThreadControl,
});

const activity = createRoute({
  getParentRoute: () => root,
  path: "/activity",
  component: ActivityControl,
});

export const router = createRouter({
  routeTree: root.addChildren([
    you.addChildren([yourView, yourThread]),
    person.addChildren([personThread]),
    activity,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

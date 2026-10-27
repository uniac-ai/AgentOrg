// Every view has a URL. The service serves the app's index.html on each of these paths
// (src/page/index.ts, APP_PATHS), and this router picks the view.

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { ActivityControl } from "./control/activity.tsx";
import { AgentControl } from "./control/agent.tsx";
import { InboxControl } from "./control/inbox.tsx";
import { OverviewControl } from "./control/overview.tsx";
import { ShellControl } from "./control/shell.tsx";
import { ThreadControl } from "./control/thread.tsx";
import { NotFoundView } from "./views/states.tsx";

const root = createRootRoute({ component: ShellControl, notFoundComponent: NotFoundView });

const home = createRoute({ getParentRoute: () => root, path: "/", component: OverviewControl });

const activity = createRoute({
  getParentRoute: () => root,
  path: "/activity",
  component: ActivityControl,
});

const inbox = createRoute({ getParentRoute: () => root, path: "/inbox", component: InboxControl });

const person = createRoute({
  getParentRoute: () => root,
  path: "/people/$agentId",
  component: AgentControl,
});

const inboxThread = createRoute({
  getParentRoute: () => inbox,
  path: "asks/$askId",
  component: ThreadControl,
});

const personThread = createRoute({
  getParentRoute: () => person,
  path: "asks/$askId",
  component: ThreadControl,
});

export const router = createRouter({
  routeTree: root.addChildren([
    home,
    activity,
    inbox.addChildren([inboxThread]),
    person.addChildren([personThread]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

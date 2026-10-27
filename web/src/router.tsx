// Every view has a URL. The service serves the app's index.html on each of these paths
// (src/page/index.ts, APP_PATHS), and this router picks the view.

import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { AgentControl } from "./control/agent.tsx";
import { InboxControl } from "./control/inbox.tsx";
import { ShellControl } from "./control/shell.tsx";
import { NotFoundView } from "./views/states.tsx";

const root = createRootRoute({ component: ShellControl, notFoundComponent: NotFoundView });

const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/inbox" });
  },
});

const inbox = createRoute({ getParentRoute: () => root, path: "/inbox", component: InboxControl });

const person = createRoute({
  getParentRoute: () => root,
  path: "/people/$agentId",
  component: AgentControl,
});

export const router = createRouter({ routeTree: root.addChildren([home, inbox, person]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

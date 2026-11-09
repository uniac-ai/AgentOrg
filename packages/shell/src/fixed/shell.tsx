// The fixed frontend: agents on the left and in the middle, Settings at the bottom.
import { PlusIcon, SettingsIcon } from "lucide-react";
import { Fragment, useLayoutEffect, useState } from "react";
import type { LoginStatus } from "../app.tsx";
import { go, type Route, useRoute } from "../data.ts";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../ui/breadcrumb.tsx";
import { Button } from "../ui/button.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";
import { AgentPage } from "./agent-page.tsx";
import { AgentSettingsPage } from "./agent-settings-page.tsx";
import { AgentsPage } from "./agents-page.tsx";
import { ChatPage } from "./chat.tsx";
import { CreateDialog } from "./create.tsx";
import { McpsPage } from "./mcps-page.tsx";
import { StateDot } from "./parts.tsx";
import { SettingsPage } from "./settings-page.tsx";
import { SkillsPage } from "./skills-page.tsx";
import { AgentsProvider, useAgents } from "./watch.tsx";

export function FixedShell({ login }: { login?: LoginStatus }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.ui = "fixed";
  }, []);
  return (
    <AgentsProvider>
      <TooltipProvider>
        <Frame login={login} />
      </TooltipProvider>
    </AgentsProvider>
  );
}

const SETTINGS: Route = { screen: "skills" };
const inSettings = (route: Route) =>
  route.screen === "skills" || route.screen === "mcps" || route.screen === "settings";

function crumbsOf(route: Route, name: string): { label: string; to?: Route }[] {
  const home = { label: "Agents", to: { screen: "home" } as Route };
  if (route.screen === "home") return [{ label: "Agents" }];
  if (inSettings(route)) return [{ label: "Settings" }];
  if (route.screen === "agent") return [home, { label: name }];
  const agent = (route as { agent: string }).agent;
  return [
    home,
    { label: name, to: { screen: "agent", agent } },
    { label: route.screen === "chat" ? "Chat" : "Settings" },
  ];
}

function Frame({ login }: { login?: LoginStatus }) {
  const route = useRoute();
  const { list, byId } = useAgents();
  const [creating, setCreating] = useState(false);
  const current = "agent" in route ? route.agent : undefined;
  const name = list.find((a) => a.agent === current)?.name ?? "";
  const row = (on: boolean) =>
    `flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] hover:bg-[var(--hover)] ${on ? "bg-[var(--selected)] font-semibold" : "text-muted-foreground"}`;
  const create = (
    <Button variant="ghost" size="icon-sm" aria-label="Create" onClick={() => setCreating(true)}>
      <PlusIcon />
    </Button>
  );
  const crumbs = crumbsOf(route, name);
  return (
    <div className="@container/app relative flex h-full w-full bg-[var(--canvas)] text-foreground">
      <nav
        aria-label="Main"
        className="flex w-[212px] shrink-0 flex-col gap-0.5 px-2.5 py-2.5 phone:hidden"
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-current={route.screen === "home" ? "page" : undefined}
            onClick={() => go({ screen: "home" })}
            className={`${row(route.screen === "home")} min-w-0 flex-1`}
          >
            Agents
          </button>
          {create}
        </div>
        <ul className="no-bar mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {list.map((agent) => (
            <li key={agent.agent}>
              <button
                type="button"
                aria-current={current === agent.agent ? "page" : undefined}
                onClick={() => go({ screen: "agent", agent: agent.agent })}
                className={row(current === agent.agent)}
              >
                <StateDot tone={byId.get(agent.agent)?.now.tone ?? "idle"} />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          aria-current={inSettings(route) ? "page" : undefined}
          onClick={() => go(SETTINGS)}
          className={row(inSettings(route))}
        >
          <SettingsIcon className="size-4" />
          Settings
        </button>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col pr-2 pb-2 phone:p-0">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap text-[13px]">
              {crumbs.map((crumb, i) => (
                <Fragment key={crumb.label}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem className="min-w-0">
                    {crumb.to ? (
                      <BreadcrumbLink asChild>
                        <button type="button" onClick={() => go(crumb.to as Route)}>
                          {crumb.label}
                        </button>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage className="truncate font-semibold">
                        {crumb.label}
                      </BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex shrink-0 items-center gap-0.5">
            <span className="wide:hidden">{create}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="wide:hidden"
              aria-label="Settings"
              onClick={() => go(SETTINGS)}
            >
              <SettingsIcon />
            </Button>
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1 gap-2">
          <main className="window @container/main relative min-w-0 flex-1 overflow-hidden rounded-2xl bg-background phone:rounded-none phone:after:hidden">
            {route.screen === "home" && <AgentsPage />}
            {route.screen === "agent" && <AgentPage key={route.agent} agent={route.agent} />}
            {route.screen === "agent-settings" && (
              <AgentSettingsPage key={route.agent} agent={route.agent} />
            )}
            {route.screen === "chat" && <ChatPage key={route.agent} agent={route.agent} />}
            {route.screen === "skills" && <SkillsPage focus={route.focus} adding={route.adding} />}
            {route.screen === "mcps" && <McpsPage focus={route.focus} adding={route.adding} />}
            {route.screen === "settings" && <SettingsPage tab={route.tab} login={login} />}
          </main>
        </div>
      </div>
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

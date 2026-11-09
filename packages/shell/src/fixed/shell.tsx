// The fixed frontend: a bar across the top, agents below it on the left, the page in the middle.
import { MessageCircleIcon, SettingsIcon } from "lucide-react";
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
import { Input } from "../ui/input.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";
import { AgentPage } from "./agent-page.tsx";
import { AgentSettingsPage } from "./agent-settings-page.tsx";
import { AgentsPage } from "./agents-page.tsx";
import { BuildDialog, CreateButton } from "./build.tsx";
import { BuildingProvider } from "./building.tsx";
import { ChatPanel } from "./chat.tsx";
import { ChatsProvider, useChats } from "./chats.tsx";
import { McpsPage } from "./mcps-page.tsx";
import { StateDot } from "./parts.tsx";
import { SettingsPage } from "./settings-page.tsx";
import { SkillsPage } from "./skills-page.tsx";
import { TemplatesPage } from "./templates-page.tsx";
import { AgentsProvider, useAgents } from "./watch.tsx";

export function FixedShell({ login }: { login?: LoginStatus }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.ui = "fixed";
  }, []);
  return (
    <AgentsProvider>
      <TooltipProvider>
        <ChatsProvider>
          <BuildingProvider>
            <Frame login={login} />
          </BuildingProvider>
        </ChatsProvider>
      </TooltipProvider>
    </AgentsProvider>
  );
}

const SETTINGS: Route = { screen: "settings", tab: "templates" };
const inSettings = (route: Route) =>
  route.screen === "skills" || route.screen === "mcps" || route.screen === "settings";

function crumbsOf(route: Route, name: string): { label: string; to?: Route }[] {
  const home = { label: "Agents", to: { screen: "home" } as Route };
  if (route.screen === "home") return [{ label: "Agents" }];
  if (inSettings(route)) return [{ label: "Settings" }];
  if (route.screen === "agent") return [home, { label: name }];
  const agent = (route as { agent: string }).agent;
  return [home, { label: name, to: { screen: "agent", agent } }, { label: "Settings" }];
}

function Frame({ login }: { login?: LoginStatus }) {
  const route = useRoute();
  const { list, byId } = useAgents();
  const chats = useChats();
  const [query, setQuery] = useState("");
  const wanted = query.trim().toLowerCase();
  const shown = list.filter((agent) => agent.name.toLowerCase().includes(wanted));
  const current = "agent" in route ? route.agent : undefined;
  const name = list.find((a) => a.agent === current)?.name ?? "";
  const row = (on: boolean) =>
    `flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] hover:bg-[var(--hover)] ${on ? "bg-[var(--selected)] font-semibold" : "text-muted-foreground"}`;
  const crumbs = crumbsOf(route, name);
  return (
    <div
      data-shell
      className="@container/app relative flex h-full w-full flex-col bg-[var(--canvas)] text-foreground"
    >
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
          <span className="wide:hidden">
            <CreateButton />
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="wide:hidden"
            aria-label="Settings"
            onClick={() => go(SETTINGS)}
          >
            <SettingsIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={chats.fresh > 0 ? `Chats, ${chats.fresh} new` : "Chats"}
            aria-pressed={chats.open}
            className={`relative ${chats.open ? "bg-[var(--selected)]" : ""}`}
            onClick={chats.toggle}
          >
            <MessageCircleIcon />
            {chats.fresh > 0 && (
              <span
                aria-hidden
                className="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-[var(--unread)] text-[10px] font-semibold text-white"
              >
                {chats.fresh}
              </span>
            )}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Main"
          className="flex w-[212px] shrink-0 flex-col gap-0.5 px-2.5 pt-1 pb-2.5 phone:hidden"
        >
          <div className="mb-1 flex items-center gap-1">
            <Input
              type="search"
              aria-label="Search agents"
              placeholder="Search"
              className="h-8 min-w-0 flex-1 text-[13px]"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <CreateButton />
          </div>
          <button
            type="button"
            aria-current={route.screen === "home" ? "page" : undefined}
            onClick={() => go({ screen: "home" })}
            className={row(route.screen === "home")}
          >
            Agents
          </button>
          <ul className="no-bar mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            {shown.map((agent) => (
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
            {shown.length === 0 && list.length > 0 && (
              <li className="px-2.5 py-1 text-[13px] text-muted-foreground">
                No agent by that name
              </li>
            )}
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
          <div className="relative flex min-h-0 flex-1 gap-2">
            <main className="window @container/main relative min-w-0 flex-1 overflow-hidden rounded-2xl bg-background phone:rounded-none phone:after:hidden">
              {route.screen === "home" && <AgentsPage />}
              {route.screen === "agent" && <AgentPage key={route.agent} agent={route.agent} />}
              {route.screen === "agent-settings" && (
                <AgentSettingsPage key={route.agent} agent={route.agent} />
              )}
              {route.screen === "skills" && (
                <SkillsPage focus={route.focus} adding={route.adding} />
              )}
              {route.screen === "mcps" && <McpsPage focus={route.focus} adding={route.adding} />}
              {route.screen === "settings" &&
                (route.tab === "templates" ? (
                  <TemplatesPage />
                ) : (
                  <SettingsPage tab={route.tab} login={login} />
                ))}
            </main>
            <ChatPanel />
          </div>
        </div>
      </div>
      <BuildDialog />
    </div>
  );
}

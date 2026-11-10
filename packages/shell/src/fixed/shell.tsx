// The fixed frontend: a bar down the left on every page, and the page beside it.
import {
  HomeIcon,
  LayoutTemplateIcon,
  MenuIcon,
  MessageCircleIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { LoginStatus } from "../app.tsx";
import { go, type Route, useRoute } from "../data.ts";
import { Button } from "../ui/button.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "../ui/sidebar.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";
import { AgentPage } from "./agent-page.tsx";
import { AgentSettingsPage } from "./agent-settings-page.tsx";
import { AgentsPage } from "./agents-page.tsx";
import { BuildDialog } from "./build.tsx";
import { BuildingProvider, useBuilding } from "./building.tsx";
import { ChatPanel } from "./chat.tsx";
import { ChatsProvider, useChats } from "./chats.tsx";
import { Face } from "./face.tsx";
import { McpsPage } from "./mcps-page.tsx";
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

const TEMPLATES: Route = { screen: "settings", tab: "templates" };
const SETTINGS: Route = { screen: "skills" };
const inTemplates = (route: Route) => route.screen === "settings" && route.tab === "templates";
const inSettings = (route: Route) =>
  route.screen === "skills" ||
  route.screen === "mcps" ||
  (route.screen === "settings" && route.tab !== "templates");

/** Under this width the bar is a rail of faces: its names go, and its search opens the whole bar. */
const RAIL = "(max-width: 959px)";
const useRail = () =>
  useSyncExternalStore(
    (changed) => {
      const media = matchMedia(RAIL);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    () => matchMedia(RAIL).matches,
  );

/** One row of the bar: what it shows first stays in the rail, and its name goes. */
function BarRow({
  label,
  current,
  onClick,
  children,
}: {
  label: string;
  current: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={label}
        isActive={current}
        aria-current={current ? "page" : undefined}
        onClick={onClick}
        className="h-10 gap-3 rounded-xl px-2 text-[15px] group-data-[collapsible=icon]:size-11! hover:not-data-[active=true]:bg-[var(--hover)]"
      >
        <span className="grid size-7 shrink-0 place-items-center [&>svg]:size-[18px]">
          {children}
        </span>
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The left bar: where you are, and the way back. Home is its first row, then a row that never
 * scrolls away, search with Create beside it. The agents scroll beneath, and Templates and
 * Settings stay at the foot.
 */
function Bar() {
  const route = useRoute();
  const { list, byId } = useAgents();
  const { show } = useBuilding();
  const { state, isMobile, openMobile, setOpenMobile } = useSidebar();
  // Each bar has its own search: the drawer's goes when it closes.
  const [query, setQuery] = useState("");
  const to = (next: Route) => {
    go(next);
    setOpenMobile(false);
  };
  // The rail has no field, so nothing there is narrowed.
  const wanted = state === "collapsed" ? "" : query.trim().toLowerCase();
  const shown = list.filter((agent) => agent.name.toLowerCase().includes(wanted));
  const current = "agent" in route ? route.agent : undefined;
  return (
    <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
      <SidebarHeader className="gap-2 p-2.5 pt-3 pb-0 group-data-[collapsible=icon]:px-2">
        <SidebarMenu>
          <BarRow
            label="Home"
            current={route.screen === "home"}
            onClick={() => to({ screen: "home" })}
          >
            <HomeIcon />
          </BarRow>
        </SidebarMenu>
        <search className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
          <input
            type="search"
            aria-label="Search"
            placeholder="Search"
            // biome-ignore lint/a11y/noAutofocus: the rail's Search opened the drawer for this field.
            autoFocus={openMobile && !isMobile}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 min-w-0 flex-1 rounded-full bg-[var(--raised)] px-3.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:hidden"
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search"
            className="hidden group-data-[collapsible=icon]:inline-flex"
            // The rail's search opens the whole bar over the page, with the field ready.
            onClick={() => setOpenMobile(true)}
          >
            <SearchIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Create"
            onClick={() => {
              setOpenMobile(false);
              show();
            }}
          >
            <PlusIcon />
          </Button>
        </search>
      </SidebarHeader>
      <SidebarContent className="no-bar p-2.5 pt-2 pb-0 group-data-[collapsible=icon]:overflow-y-auto group-data-[collapsible=icon]:px-2">
        <SidebarMenu aria-label="Agents">
          {shown.map((agent) => (
            <BarRow
              key={agent.agent}
              label={agent.name}
              current={current === agent.agent}
              onClick={() => to({ screen: "agent", agent: agent.agent })}
            >
              <Face
                id={agent.agent}
                name={agent.name}
                tone={byId.get(agent.agent)?.now.tone ?? "idle"}
              />
            </BarRow>
          ))}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter className="p-2.5 pt-1 group-data-[collapsible=icon]:px-2">
        <SidebarMenu>
          <BarRow label="Templates" current={inTemplates(route)} onClick={() => to(TEMPLATES)}>
            <LayoutTemplateIcon />
          </BarRow>
          <BarRow label="Settings" current={inSettings(route)} onClick={() => to(SETTINGS)}>
            <SettingsIcon />
          </BarRow>
        </SidebarMenu>
      </SidebarFooter>
    </nav>
  );
}

/** On a phone the bar is behind this, and the top of the page names the place. */
function PhoneHead() {
  const route = useRoute();
  const { list } = useAgents();
  const { openMobile, setOpenMobile } = useSidebar();
  const place =
    route.screen === "home"
      ? "Home"
      : "agent" in route
        ? list.find((agent) => agent.agent === route.agent)?.name
        : inTemplates(route)
          ? "Templates"
          : "Settings";
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 px-2 sm:hidden">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Menu"
        aria-expanded={openMobile}
        onClick={() => setOpenMobile(true)}
      >
        <MenuIcon />
      </Button>
      <span className="min-w-0 truncate text-[17px] font-semibold">{place}</span>
    </header>
  );
}

function Frame({ login }: { login?: LoginStatus }) {
  const route = useRoute();
  const chats = useChats();
  const rail = useRail();
  return (
    <SidebarProvider
      data-shell
      open={!rail}
      className="@container/app relative h-full min-h-0 bg-[var(--canvas)] text-foreground"
    >
      <Sidebar collapsible="icon" className="group-data-[side=left]:border-r-0">
        <Bar />
      </Sidebar>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:p-2 sm:pl-0">
        <PhoneHead />
        <div className="relative flex min-h-0 flex-1 gap-2">
          <main className="window @container/main relative min-w-0 flex-1 overflow-hidden rounded-2xl bg-background max-sm:rounded-none max-sm:after:hidden">
            {route.screen === "home" && <AgentsPage />}
            {route.screen === "agent" && <AgentPage key={route.agent} agent={route.agent} />}
            {route.screen === "agent-settings" && (
              <AgentSettingsPage key={route.agent} agent={route.agent} />
            )}
            {route.screen === "skills" && <SkillsPage focus={route.focus} adding={route.adding} />}
            {route.screen === "mcps" && <McpsPage focus={route.focus} adding={route.adding} />}
            {route.screen === "settings" &&
              (route.tab === "templates" ? (
                <TemplatesPage />
              ) : (
                <SettingsPage tab={route.tab} login={login} />
              ))}
          </main>
          <ChatPanel />
          {!chats.open && (
            <Button
              variant="secondary"
              size="icon-lg"
              aria-label={chats.fresh > 0 ? `Chats, ${chats.fresh} new` : "Chats"}
              className="absolute right-3 bottom-3 z-20 size-12 rounded-full shadow-lg"
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
          )}
        </div>
      </div>
      <BuildDialog />
    </SidebarProvider>
  );
}

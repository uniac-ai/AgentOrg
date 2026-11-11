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
import { Dialog } from "radix-ui";
import { useLayoutEffect, useRef, useState } from "react";
import type { LoginStatus } from "../app.tsx";
import { go, type Route, useRoute } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";
import { AgentPage } from "./agent-page.tsx";
import { AgentSettingsPage } from "./agent-settings-page.tsx";
import { AgentsPage } from "./agents-page.tsx";
import { AllChatsProvider, useAllChats } from "./all-chats.tsx";
import { BuildDialog } from "./build.tsx";
import { BuildingProvider, useBuilding } from "./building.tsx";
import { ChatsProvider, useChats } from "./chats.tsx";
import { Face } from "./face.tsx";
import { Layer } from "./layer.tsx";
import { McpsPage } from "./mcps-page.tsx";
import { WORD } from "./parts.tsx";
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
          <AllChatsProvider>
            <BuildingProvider>
              <Frame login={login} />
            </BuildingProvider>
          </AllChatsProvider>
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

/** One row of the left bar. As a rail, what a row shows first stays and its name goes. */
function BarRow({
  current,
  onClick,
  label,
  name = label,
  rail,
  children,
}: {
  current: boolean;
  onClick(): void;
  label: string;
  /** What a screen reader is told, where it is more than the label. */
  name?: string;
  rail: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      aria-label={name}
      title={label}
      onClick={onClick}
      className={`flex h-10 w-full min-w-0 shrink-0 items-center gap-3 rounded-xl px-2 text-left text-[15px] hover:bg-[var(--hover)] ${rail ? "rail:justify-center rail:px-0" : ""} ${current ? "bg-[var(--selected)] font-medium" : ""}`}
    >
      <span className="grid size-7 shrink-0 place-items-center">{children}</span>
      <span className={`min-w-0 flex-1 truncate ${rail ? "rail:hidden" : ""}`}>{label}</span>
    </button>
  );
}

/**
 * The left bar, on every page: where you are, and the way back. It carries no name or mark of the
 * product: Home is its first row. Then a row that never scrolls away, search with Create beside
 * it. The agents scroll beneath, and Templates and Settings stay at the foot. Narrow, it is a rail
 * of faces; its search, and a phone's menu button, open the whole bar as a drawer.
 */
function LeftBar({
  drawer = false,
  searching = false,
  onGo,
  onSearch,
  onCreate,
}: {
  drawer?: boolean;
  /** A drawer opened to search, so its field is ready. */
  searching?: boolean;
  /** Told when a row took you somewhere, so a drawer can close. */
  onGo?: () => void;
  /** What the rail's search does. */
  onSearch?: (event: React.MouseEvent) => void;
  onCreate(): void;
}) {
  const route = useRoute();
  const { list, byId } = useAgents();
  const { chats } = useAllChats();
  const { openChat } = useChats();
  const [query, setQuery] = useState("");
  const rail = !drawer;
  const to = (next: Route) => {
    go(next);
    onGo?.();
  };
  // Search finds agents and chats by name. The agents it finds stay where the agents are.
  const wanted = query.trim().toLowerCase();
  const foundChats = wanted
    ? chats.filter((chat) => !chat.archived && chat.entry.title.toLowerCase().includes(wanted))
    : [];
  const current = "agent" in route ? route.agent : undefined;
  return (
    <nav
      aria-label="Main"
      className={
        drawer
          ? "flex h-full w-[272px] flex-col gap-0.5 bg-[var(--canvas)] p-2.5 pt-3 shadow-2xl"
          : "flex w-[236px] shrink-0 flex-col gap-0.5 p-2.5 pt-3 rail:w-[60px] rail:px-2 phone:hidden"
      }
    >
      <BarRow
        rail={rail}
        current={route.screen === "home"}
        onClick={() => to({ screen: "home" })}
        label="Home"
      >
        <span className="relative">
          <HomeIcon className="size-[18px]" />
        </span>
      </BarRow>
      {/* Search, with Create beside it. This row stays put however long the list beneath grows. */}
      <search className={`mt-1.5 flex shrink-0 items-center gap-1 ${rail ? "rail:flex-col" : ""}`}>
        <input
          type="search"
          aria-label="Search"
          placeholder="Search"
          // biome-ignore lint/a11y/noAutofocus: the rail's Search opened the drawer for this field.
          autoFocus={searching}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={`h-9 min-w-0 flex-1 rounded-full bg-[var(--raised)] px-3.5 text-sm outline-none placeholder:text-muted-foreground ${rail ? "rail:hidden" : ""}`}
        />
        {rail && (
          <Button
            variant="ghost"
            size="icon"
            className="hidden rail:inline-flex"
            aria-label="Search"
            onClick={onSearch}
          >
            <SearchIcon />
          </Button>
        )}
        <Button variant="ghost" size="icon" aria-label="Create" title="Create" onClick={onCreate}>
          <PlusIcon />
        </Button>
      </search>
      <div className="no-bar mt-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        <ul aria-label="Agents" className="flex flex-col gap-0.5">
          {list.map((agent) => {
            const tone = byId.get(agent.agent)?.now.tone ?? "idle";
            // The rail has no field to show or clear a search, so there it narrows nothing.
            const found = agent.name.toLowerCase().includes(wanted);
            if (drawer && !found) return null;
            return (
              <li key={agent.agent} className={found ? undefined : "hidden rail:list-item"}>
                <BarRow
                  rail={rail}
                  current={current === agent.agent}
                  onClick={() => to({ screen: "agent", agent: agent.agent })}
                  label={agent.name}
                  name={`${WORD[tone]} ${agent.name}`}
                >
                  <Face agent={{ id: agent.agent, name: agent.name, tone }} size={28} />
                </BarRow>
              </li>
            );
          })}
        </ul>
        {foundChats.length > 0 && (
          <ul aria-label="Chats found" className="mt-3 flex flex-col gap-0.5">
            {foundChats.map((chat) => (
              <li key={`${chat.agent.id} ${chat.entry.id}`}>
                <button
                  type="button"
                  onClick={() => {
                    openChat(chat.agent.id, chat.entry.id);
                    onGo?.();
                  }}
                  className="flex h-10 w-full min-w-0 items-center gap-3 rounded-xl px-2 text-left text-[15px] hover:bg-[var(--hover)]"
                >
                  <span className="grid size-7 shrink-0 place-items-center">
                    <MessageCircleIcon className="size-[18px] text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{chat.entry.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <BarRow
        rail={rail}
        current={inTemplates(route)}
        onClick={() => to(TEMPLATES)}
        label="Templates"
      >
        <LayoutTemplateIcon className="size-[18px]" />
      </BarRow>
      <BarRow rail={rail} current={inSettings(route)} onClick={() => to(SETTINGS)} label="Settings">
        <SettingsIcon className="size-[18px]" />
      </BarRow>
    </nav>
  );
}

function Frame({ login }: { login?: LoginStatus }) {
  const route = useRoute();
  const { list } = useAgents();
  /** The whole bar as a drawer: from a phone's menu button, or from the rail's search. */
  const [drawer, setDrawer] = useState<"menu" | "search">();
  /** What opened the drawer, which has the keyboard again when it closes. */
  const opener = useRef<HTMLElement | null>(null);
  /** Create was pressed in the drawer: its window opens once the drawer has closed. */
  const creating = useRef(false);
  /** The drawer is drawn inside the shell, so it has the shell's type. */
  const [shell, setShell] = useState<HTMLElement | null>(null);
  const { show } = useBuilding();
  const open = (how: "menu" | "search", event: React.MouseEvent) => {
    opener.current = event.currentTarget as HTMLElement;
    setDrawer(how);
  };
  const place =
    route.screen === "home"
      ? "Home"
      : "agent" in route
        ? list.find((agent) => agent.agent === route.agent)?.name
        : inTemplates(route)
          ? "Templates"
          : "Settings";
  return (
    <div
      ref={setShell}
      data-shell
      className="@container/app relative flex h-full min-h-0 w-full overflow-hidden bg-[var(--canvas)] text-[15px] leading-[1.5] text-foreground"
    >
      {/* The page: the bar and what's beside it. */}
      <LeftBar onSearch={(event) => open("search", event)} onCreate={show} />
      <Dialog.Root open={!!drawer} onOpenChange={(next) => !next && setDrawer(undefined)}>
        <Dialog.Portal container={shell}>
          <Dialog.Overlay
            data-drawer-overlay
            className="fixed inset-0 z-30 bg-black/40"
            onClick={() => setDrawer(undefined)}
          />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-40 outline-none"
            // A click on the page behind closes it, as it lands, and not the press before it.
            onPointerDownOutside={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              opener.current?.focus();
              if (creating.current) show();
              creating.current = false;
            }}
          >
            <Dialog.Title className="sr-only">Menu</Dialog.Title>
            <LeftBar
              drawer
              searching={drawer === "search"}
              onGo={() => setDrawer(undefined)}
              onCreate={() => {
                creating.current = true;
                setDrawer(undefined);
              }}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="hidden h-12 shrink-0 items-center gap-1 px-2 phone:flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Menu"
            aria-expanded={!!drawer}
            onClick={(event) => open("menu", event)}
          >
            <MenuIcon />
          </Button>
          <span className="min-w-0 truncate text-[17px] font-semibold">{place}</span>
        </header>
        {/* The pages are set in the type they were built in, not the frame's. */}
        <main className="@container/main relative min-h-0 flex-1 text-[14px] leading-[1.45]">
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
      </div>
      {/* Over the page, bar included: the one layer, with the chat. */}
      <Layer />
      <BuildDialog />
    </div>
  );
}

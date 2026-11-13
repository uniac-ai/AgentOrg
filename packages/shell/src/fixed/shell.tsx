// The fixed frontend: a bar down the left on every page, and the page beside it.
import {
  HomeIcon,
  LayoutTemplateIcon,
  LoaderCircleIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { useLayoutEffect, useRef, useState } from "react";
import { USAGE, useWaited } from "../app.tsx";
import { go, type Route, useConnection, useRoute } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";
import { AgentPage } from "./agent-page.tsx";
import { AllChatsProvider } from "./all-chats.tsx";
import { BuildDialog } from "./build.tsx";
import { BuildingProvider, useBuilding } from "./building.tsx";
import { ChatsProvider, useChats } from "./chats.tsx";
import { ComputerViews } from "./computer.tsx";
import { ComputersProvider } from "./computers.tsx";
import { WORD } from "./data.ts";
import { Face } from "./face.tsx";
import { HomePage } from "./home-page.tsx";
import { Layer } from "./layer.tsx";
import { LoginProvider, type LoginStatus, useLogin } from "./login.tsx";
import { McpsPage } from "./mcps-page.tsx";
import { UNREAD } from "./parts.tsx";
import { SettingsFrame, SettingsPage, sectionOf } from "./settings-page.tsx";
import { SkillsPage } from "./skills-page.tsx";
import { TemplatesPage } from "./templates-page.tsx";
import { AgentsProvider, useAgents } from "./watch.tsx";

/** The plan's notice, while it is to be shown, and what dismisses it. */
interface Notice {
  notice?: boolean;
  dismiss?(): void;
}

export function FixedShell({
  login,
  notice = false,
  dismiss = () => {},
}: { login?: LoginStatus } & Notice) {
  useLayoutEffect(() => {
    document.documentElement.dataset.ui = "fixed";
  }, []);
  return (
    <AgentsProvider>
      <TooltipProvider>
        <ChatsProvider>
          <AllChatsProvider>
            <BuildingProvider>
              <ComputersProvider>
                <LoginProvider status={login}>
                  <Frame notice={notice} dismiss={dismiss} />
                  {/* Each computer's views, which outlive the frame they are shown in. */}
                  <ComputerViews />
                </LoginProvider>
              </ComputersProvider>
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
  const { list, byId, unread } = useAgents();
  const login = useLogin();
  const [query, setQuery] = useState("");
  const rail = !drawer;
  const to = (next: Route) => {
    go(next);
    onGo?.();
  };
  // Search finds agents by name, and they stay where the agents are. A conversation has no name of
  // its own: it is its agent's.
  const wanted = query.trim().toLowerCase();
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
          {/* Something is left to set up, and Home is where. */}
          {login !== "in" && (
            <span className="absolute -top-0.5 -right-1 size-2 rounded-full bg-[var(--warn)] ring-2 ring-[var(--canvas)]" />
          )}
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
        {/* Agents that can't be read: the bar says so where they would be. */}
        {unread && (
          <p className={`px-2 py-2 text-[13px] text-[var(--faint)] ${rail ? "rail:hidden" : ""}`}>
            {UNREAD}
          </p>
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

/**
 * The shell's one bar, at the foot of the page beside the left bar, where it lies over nothing: a
 * page ends well above it, and the chat is at the other side. While the chat is open the bar ends
 * one gap short of it, its words cut as on a phone, so its link and its close stay whole. It holds
 * the plan's notice, once, until it is dismissed; while the shell is reconnecting it says so. On a
 * phone it sits above the chat's place, as wide as the page.
 */
function ShellBar({ notice, dismiss }: Required<Notice>) {
  const { open } = useChats();
  const reconnecting = useWaited(useConnection() !== "open");
  if (!notice && !reconnecting) return null;
  const room = open
    ? "max-w-[calc(100%-2*var(--inset)-var(--panel)-var(--gap))] phone:max-w-[calc(100%-2*var(--inset))]"
    : "max-w-[calc(100%-2*var(--inset))]";
  return (
    <div
      role="status"
      className={`window absolute bottom-[var(--inset)] left-[var(--inset)] z-20 flex h-10 ${room} items-center gap-3 rounded-full bg-[var(--raised)] pr-1.5 pl-4 text-[13px] shadow-lg phone:right-[var(--inset)] phone:bottom-[calc(var(--inset)+var(--tab)+var(--gap))]`}
    >
      {reconnecting ? (
        <>
          <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
          <span className="pr-2.5">Reconnecting…</span>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">You're using your ChatGPT plan</span>
          <a
            href={USAGE}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Manage usage
          </a>
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={dismiss}>
            <XIcon />
          </Button>
        </>
      )}
    </div>
  );
}

function Frame({ notice, dismiss }: Required<Notice>) {
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
  const section = sectionOf(route);
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
        <ShellBar notice={notice} dismiss={dismiss} />
        <main className="@container/main relative min-h-0 flex-1">
          {route.screen === "home" && <HomePage />}
          {route.screen === "agent" && (
            <AgentPage key={route.agent} agent={route.agent} tab={route.tab} />
          )}
          {section && (
            <SettingsFrame tab={section}>
              {route.screen === "skills" && (
                <SkillsPage focus={route.focus} adding={route.adding} />
              )}
              {route.screen === "mcps" && <McpsPage focus={route.focus} adding={route.adding} />}
              {route.screen === "settings" &&
                (route.tab === "templates" ? <TemplatesPage /> : <SettingsPage tab={route.tab} />)}
            </SettingsFrame>
          )}
        </main>
      </div>
      {/* Over the page, bar included: the one layer, with the chat. */}
      <Layer />
      <BuildDialog />
    </div>
  );
}

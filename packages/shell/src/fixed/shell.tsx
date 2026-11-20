// The fixed frontend: a bar of icons down the left on every page, and the page beside it. On a
// phone the bar runs along the foot.
import { MessageCircleIcon, SearchIcon, SettingsIcon, UsersIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { USAGE } from "../app.tsx";
import { go, openSettings, useRoute, useSettings } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip.tsx";
import { AllChatsProvider, useAllChats } from "./all-chats.tsx";
import { BuildDialog } from "./build.tsx";
import { BuildingProvider } from "./building.tsx";
import { ChatPage } from "./chat-page.tsx";
import { ChatsProvider, useChats } from "./chats.tsx";
import { ComputerViews } from "./computer.tsx";
import { ComputersProvider } from "./computers.tsx";
import { Layer } from "./layer.tsx";
import { LoginProvider, type LoginStatus, SignInBanner } from "./login.tsx";
import { Offline, useOffline } from "./offline.tsx";
import { PresenceProvider } from "./presence.tsx";
import { Search } from "./search.tsx";
import { SettingsWindow } from "./settings-window.tsx";
import { TeamPage } from "./team-page.tsx";
import { AgentsProvider } from "./watch.tsx";

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
                <PresenceProvider>
                  <LoginProvider status={login}>
                    <Frame notice={notice} dismiss={dismiss} />
                    {/* Each computer's views, which outlive the frame they are shown in. */}
                    <ComputerViews />
                  </LoginProvider>
                </PresenceProvider>
              </ComputersProvider>
            </BuildingProvider>
          </AllChatsProvider>
        </ChatsProvider>
      </TooltipProvider>
    </AgentsProvider>
  );
}

/**
 * One place of the bar: an icon alone. Its label shows beside it while the pointer rests on it or
 * the keyboard is on it, fading in and out. On a phone each label sits under its icon instead.
 */
function Place({
  label,
  name = label,
  current,
  onClick,
  children,
  ...rest
}: {
  label: string;
  /** What a screen reader is told, where it is more than the label. */
  name?: string;
  current: boolean;
  onClick(): void;
  children: React.ReactNode;
} & Omit<React.ComponentProps<"button">, "name">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={name}
          aria-current={current ? "page" : undefined}
          onClick={onClick}
          {...rest}
          className={`relative grid size-11 shrink-0 place-items-center rounded-xl ${current ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"} phone:flex phone:h-full phone:w-auto phone:flex-1 phone:flex-col phone:items-center phone:justify-center phone:gap-0.5 phone:rounded-none phone:bg-transparent phone:hover:bg-transparent ${current ? "" : "phone:text-muted-foreground"}`}
        >
          {children}
          <span className="hidden text-[10px] leading-3 font-medium phone:block">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={6}
        className="max-sm:hidden data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=instant-open]:zoom-in-95"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Whether this is a Mac, an iPhone or an iPad, where ⌘ is the key for the page's own shortcuts and
 * Ctrl is left to what has the keyboard.
 */
const onApple = () => {
  const said = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad/i.test(said?.platform || navigator.platform);
};

/**
 * The bar, on every page: icons only, Search, Chat and Team in the middle of its height and Settings
 * at its foot. It holds no words and no agents: the agents are on Team. Chat carries the count of
 * conversations with something new, as the floating chat's button does. Search opens from its key
 * too, anywhere, with nothing drawn to say so: ⌘K on a Mac, and Ctrl K elsewhere. A terminal keeps
 * Ctrl K itself: xterm takes it at its own text area, and the window never hears it. While the
 * service is out of reach nothing opens over the notice.
 */
function IconBar() {
  const route = useRoute();
  const settings = useSettings();
  const unread = useAllChats().chats.filter((chat) => chat.unread).length;
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const search = (open: boolean) => {
    setSearching(open);
    if (!open) setQuery("");
  };
  // The page is inert under the notice, but the key is heard on the window.
  const offline = useRef(false);
  offline.current = useOffline();
  useEffect(() => {
    const apple = onApple();
    const key = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey || offline.current)
        return;
      const asked = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!asked) return;
      event.preventDefault();
      setSearching(true);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  const icon = "size-[22px]";
  return (
    <nav
      aria-label="Main"
      className="relative flex w-[60px] shrink-0 flex-col items-center justify-center gap-3 border-r py-3 phone:order-last phone:h-[var(--foot)] phone:w-full phone:flex-row phone:gap-0 phone:border-t phone:border-r-0 phone:py-0"
    >
      <Place
        label="Search"
        current={false}
        aria-haspopup="dialog"
        aria-expanded={searching}
        onClick={() => setSearching(true)}
      >
        <SearchIcon className={icon} />
      </Place>
      <Search open={searching} onOpenChange={search} query={query} onQuery={setQuery} />
      <Place
        label="Chat"
        name={unread > 0 ? `Chat, ${unread} new` : "Chat"}
        current={route.screen === "chat"}
        onClick={() => go({ screen: "chat" })}
      >
        <span className="relative grid place-items-center">
          <MessageCircleIcon className={icon} />
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute -top-1.5 -right-2 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--unread)] px-1 text-[10px] leading-none font-semibold text-white"
            >
              {unread}
            </span>
          )}
        </span>
      </Place>
      <Place label="Team" current={route.screen === "team"} onClick={() => go({ screen: "team" })}>
        <UsersIcon className={icon} />
      </Place>
      {/* Settings stays at the foot, so the places are centered on the bar's whole height. */}
      <div className="absolute bottom-3 phone:static phone:flex phone:h-full phone:flex-1">
        {/* Settings is a window over the place, not a place: it is never the current one. */}
        <Place
          label="Settings"
          current={false}
          aria-haspopup="dialog"
          aria-expanded={settings.open}
          onClick={() => openSettings()}
        >
          <SettingsIcon className={icon} />
        </Place>
      </div>
    </nav>
  );
}

/**
 * The shell's one bar, at the foot of the page beside the bar of icons, where it lies over nothing: a
 * page ends well above it, and the chat is at the other side. While the chat is open the bar ends
 * one gap short of it, its words cut as on a phone, so its link and its close stay whole. It holds
 * the plan's notice, once, until it is dismissed (being offline is the notice at the top). On a
 * phone it sits above the chat's place, as wide as the page.
 */
function ShellBar({ notice, dismiss }: Required<Notice>) {
  const chats = useChats();
  const route = useRoute();
  // On the chat page there is no chat in the layer to leave room for.
  const open = chats.open && route.screen !== "chat";
  if (!notice) return null;
  const room = open
    ? "max-w-[calc(100%-2*var(--inset)-var(--panel)-var(--gap))] phone:max-w-[calc(100%-2*var(--inset))]"
    : "max-w-[calc(100%-2*var(--inset))]";
  return (
    <div
      role="status"
      className={`window absolute bottom-[var(--inset)] left-[var(--inset)] z-20 flex h-10 ${room} items-center gap-3 rounded-full bg-[var(--raised)] pr-1.5 pl-4 text-[13px] shadow-lg phone:right-[var(--inset)] phone:bottom-[calc(var(--inset)+var(--foot)+var(--tab)+var(--gap))]`}
    >
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
    </div>
  );
}

function Frame({ notice, dismiss }: Required<Notice>) {
  const route = useRoute();
  // Out of reach, all of it is under the notice: the keyboard doesn't reach it either.
  const offline = useOffline();
  return (
    // What is left to set up runs across the top, over the bar and the page; the shell, with its
    // layer, is below it.
    <>
      <div
        inert={offline || undefined}
        className="@container/app flex h-full min-h-0 w-full flex-col bg-[var(--canvas)] text-[15px] leading-[1.5] text-foreground"
      >
        <SignInBanner />
        <div
          data-shell
          className="@container/app relative flex min-h-0 w-full flex-1 overflow-hidden bg-[var(--canvas)]"
        >
          {/* The page: the bar and the place beside it. On a phone the bar is along the foot. */}
          <div className="flex min-h-0 min-w-0 flex-1 phone:flex-col">
            <IconBar />
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              <ShellBar notice={notice} dismiss={dismiss} />
              <main className="@container/main relative min-h-0 flex-1">
                {route.screen === "chat" && <ChatPage agent={route.agent} />}
                {route.screen === "team" && <TeamPage agent={route.agent} tab={route.tab} />}
              </main>
            </div>
          </div>
          {/* Over the page, bar included: the one layer, with the chat. */}
          <Layer />
          {/* Settings, a window over the place; the creation window opens over it. */}
          <SettingsWindow />
          <BuildDialog />
        </div>
      </div>
      {offline && <Offline />}
    </>
  );
}

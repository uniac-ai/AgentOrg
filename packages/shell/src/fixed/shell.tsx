// The fixed frontend: the ground, with the page on it. Wider than a phone, the page's list is at
// the left, on the ground itself, between the frame's two rows: Search at the end of a strip along
// the top, and the places with Settings along the foot. What the page shows is in cards beside
// them. On a phone the places and Search run along the foot, and the page has the rest.
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
 * One place: an icon alone. Its label shows on its `side` while the pointer rests on it or the
 * keyboard is on it, fading in and out. On a phone each label sits under its icon instead.
 */
function Place({
  label,
  name = label,
  side,
  current,
  onClick,
  children,
  ...rest
}: {
  label: string;
  /** What a screen reader is told, where it is more than the label. */
  name?: string;
  side: "top" | "bottom";
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
          className={`pointer-events-auto relative grid size-11 shrink-0 place-items-center rounded-xl ${current ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"} phone:flex phone:h-full phone:w-auto phone:flex-1 phone:flex-col phone:items-center phone:justify-center phone:gap-0.5 phone:rounded-none phone:bg-transparent phone:hover:bg-transparent ${current ? "" : "phone:text-muted-foreground"}`}
        >
          {children}
          <span className="hidden text-[10px] leading-3 font-medium phone:block">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
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
 * The frame's two rows, on every page, icons only. Wider than a phone they lie over the page's left
 * side, as wide as its list beside what is chosen, and the page leaves them their room: a strip
 * along the top with Search at its end, its start left empty for a window's own buttons, and a row
 * along the foot with the places from its start and Settings at its end. On a phone they are one
 * row along the foot. Chat carries the count of conversations with something
 * new, as the floating chat's button does. Search opens from its key too, anywhere, with nothing
 * drawn to say so: ⌘K on a Mac, and Ctrl K elsewhere. A terminal keeps Ctrl K itself: xterm takes it
 * at its own text area, and the window never hears it. While the service is out of reach nothing
 * opens over the notice.
 */
function Places() {
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
      className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-[var(--side)] flex-col justify-between phone:pointer-events-auto phone:static phone:order-last phone:h-[var(--foot)] phone:w-full phone:shrink-0 phone:flex-row phone:border-t"
    >
      <div className="flex h-[var(--strip)] shrink-0 items-center justify-end pr-1 phone:contents">
        <Place
          label="Search"
          side="bottom"
          current={false}
          aria-haspopup="dialog"
          aria-expanded={searching}
          onClick={() => setSearching(true)}
        >
          <SearchIcon className={icon} />
        </Place>
      </div>
      <Search open={searching} onOpenChange={search} query={query} onQuery={setQuery} />
      <div className="flex h-[var(--foot)] shrink-0 items-center justify-between px-2 phone:contents">
        {/* The places, side by side from the row's start. */}
        <div className="flex gap-1 phone:contents">
          <Place
            label="Chat"
            name={unread > 0 ? `Chat, ${unread} new` : "Chat"}
            side="top"
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
          <Place
            label="Team"
            side="top"
            current={route.screen === "team"}
            onClick={() => go({ screen: "team" })}
          >
            <UsersIcon className={icon} />
          </Place>
        </div>
        {/* Settings is a window over the place, not a place: it is never the current one. */}
        <Place
          label="Settings"
          side="top"
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
 * The shell's one bar, where it lies over nothing. Beside what is chosen it is over the foot of the
 * page's list, above the row of places: a list ends well above it. It is no wider than the list, its
 * words cut, so its link and its close stay whole. Where the page holds one thing at a time it is
 * beside the row of places, short of the chat's tab; with the chat open there is no room there, and
 * it is above the places as beside a list, where a page with the chat over it ends well above it. On
 * a phone it has a row of its own along the top, above the page. It holds the plan's notice, once,
 * until it is dismissed (being offline is the notice at the top).
 */
function ShellBar({ notice, dismiss }: Required<Notice>) {
  const chats = useChats();
  const route = useRoute();
  // On the chat page there is no chat in the layer to leave room for.
  const open = chats.open && route.screen !== "chat";
  if (!notice) return null;
  const at = open
    ? "bottom-[calc(var(--foot)+6px)] left-3 max-w-[calc(var(--side)-24px)]"
    : "bottom-2 left-[calc(var(--side)+12px)] max-w-[calc(100%-var(--side)-12px-var(--inset)-var(--tab-open)-var(--gap))] split:bottom-[calc(var(--foot)+6px)] split:left-3 split:max-w-[calc(var(--side)-24px)]";
  return (
    <div
      role="status"
      className={`window absolute z-20 flex h-10 ${at} items-center gap-3 rounded-full bg-[var(--raised)] pr-1.5 pl-4 text-[13px] shadow-lg phone:relative phone:inset-auto phone:mx-3 phone:my-2 phone:max-w-none phone:shrink-0`}
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
    // What is left to set up runs across the top, over the frame's rows and the page; the shell,
    // with its layer, is below it.
    <>
      <div
        inert={offline || undefined}
        className="@container/app flex h-full min-h-0 w-full flex-col bg-[var(--canvas)] text-[15px] leading-[1.5] text-foreground"
      >
        <SignInBanner />
        {/* The ground, under the frame's rows and the page's list and around its cards. */}
        <div
          data-shell
          className="@container/app relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-[var(--ground)]"
        >
          <Places />
          <ShellBar notice={notice} dismiss={dismiss} />
          <main className="@container/main relative min-h-0 flex-1">
            {route.screen === "chat" && <ChatPage agent={route.agent} />}
            {route.screen === "team" && <TeamPage agent={route.agent} tab={route.tab} />}
          </main>
          {/* Over the page and the frame's rows: the one layer, with the chat. */}
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

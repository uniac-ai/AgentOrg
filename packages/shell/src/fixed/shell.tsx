// The fixed frontend: the ground, with the page on it. Wider than a phone, the page's list is at
// the left, on the ground itself, between the frame's two rows: Search at the end of a strip along
// the top, and the places with Settings along the foot. What the page shows is in cards beside
// them. With the list put away the card has the window, and that left side comes back over it
// while it is looked at. On a phone the places and Search run along the foot, and the page has
// the rest.
import {
  MessageCircleIcon,
  PanelLeftIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { USAGE } from "../app.tsx";
import { api, go, openSettings, useRoute, useSettings } from "../data.ts";
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
import { SIDE_PART } from "./page-frame.tsx";
import { PresenceProvider } from "./presence.tsx";
import { Search } from "./search.tsx";
import { SettingsWindow } from "./settings-window.tsx";
import { setCollapsed, settle, useCollapsed, useOpenedAway } from "./split.ts";
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
 * One place: an icon alone, in a box of its `size`. Its label shows on its `side` while the pointer
 * rests on it or the keyboard is on it, fading in and out. On a phone each label sits under its
 * icon instead.
 */
function Place({
  label,
  name = label,
  side,
  size,
  current,
  onClick,
  children,
  ...rest
}: {
  label: string;
  /** What a screen reader is told, where it is more than the label. */
  name?: string;
  side: "top" | "bottom";
  /** Square and small in the strip; along the foot larger, a little less tall than wide. */
  size: "size-8" | "h-9 w-11";
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
          className={`pointer-events-auto relative grid ${size} shrink-0 place-items-center ${size === "size-8" ? "rounded-lg" : "rounded-xl"} ${current ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"} phone:flex phone:h-full phone:w-auto phone:flex-1 phone:flex-col phone:items-center phone:justify-center phone:gap-0.5 phone:rounded-none phone:bg-transparent phone:hover:bg-transparent ${current ? "" : "phone:text-muted-foreground"}`}
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

/** The places, in the order they have in their row. */
const PLACES = ["chat", "team"] as const;

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
 * along the top with Search at its end, and a row along the foot with the places from its start
 * and Settings at its end. With the list put away they go with it off the window's edge, and
 * come back with it. On a phone they are one row along the foot. Chat carries the count of conversations with something new, as the floating
 * chat's button does. Search opens from its key too, anywhere, with nothing drawn to say so: ⌘K on
 * a Mac, and Ctrl K elsewhere. A terminal keeps Ctrl K itself: xterm takes it at its own text area,
 * and the window never hears it. While the service is out of reach nothing opens over the notice.
 *
 * A sideways scroll over the rows or the page's list goes to the next place in the row, or the one
 * before it: one place a gesture, however long it runs on. A scroll up or down is the list's own.
 */
function Places() {
  const route = useRoute();
  const screen = useRef(route.screen);
  screen.current = route.screen;
  useEffect(() => {
    /** How far this gesture has gone sideways, and whether it has changed the place already. */
    let gone = 0;
    let changed = false;
    let rest: ReturnType<typeof setTimeout>;
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const over = event.target instanceof Element ? event.target : null;
      if (!over?.closest('nav[aria-label="Main"], [data-list]')) return;
      // Ours, so the browser doesn't take it for its own way back or forward.
      event.preventDefault();
      // A gesture ends when nothing has come of it for a moment.
      clearTimeout(rest);
      rest = setTimeout(() => {
        gone = 0;
        changed = false;
      }, 200);
      if (changed) return;
      // A wheel that counts in lines says a line where a trackpad says its pixels.
      gone += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaX * 16 : event.deltaX;
      if (Math.abs(gone) < 40) return;
      changed = true;
      const to = PLACES[PLACES.indexOf(screen.current) + Math.sign(gone)];
      if (to) go({ screen: to });
    };
    addEventListener("wheel", wheel, { passive: false });
    return () => {
      removeEventListener("wheel", wheel);
      clearTimeout(rest);
    };
  }, []);
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
      className={`pointer-events-none absolute inset-y-0 left-0 z-10 flex w-[var(--side)] flex-col justify-between away:z-40 ${SIDE_PART} phone:pointer-events-auto phone:static phone:order-last phone:h-[var(--foot)] phone:w-full phone:shrink-0 phone:flex-row phone:border-t`}
    >
      {/* Search's box is 10 from the strip's end and its top, its icon where a larger box had it. */}
      <div className="flex h-[var(--strip)] shrink-0 items-center justify-end pr-2.5 phone:contents">
        <Place
          label="Search"
          side="bottom"
          size="size-8"
          current={false}
          aria-haspopup="dialog"
          aria-expanded={searching}
          onClick={() => setSearching(true)}
        >
          {/* Quieter than a place in the strip: smaller, thinner and grey. On a phone it is one of
              the row's four, drawn as they are. */}
          <SearchIcon className="size-[18px] stroke-[1.5] text-muted-foreground phone:size-[22px] phone:stroke-2" />
        </Place>
      </div>
      <Search open={searching} onOpenChange={search} query={query} onQuery={setQuery} />
      {/* The row's places end 12 from the window's foot, level with a card beside them. */}
      <div className="flex h-[var(--foot)] shrink-0 items-end justify-between px-2 pb-3 phone:contents">
        {/* The places, side by side from the row's start. */}
        <div className="flex gap-1 phone:contents">
          <Place
            label="Chat"
            name={unread > 0 ? `Chat, ${unread} new` : "Chat"}
            side="top"
            size="h-9 w-11"
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
            size="h-9 w-11"
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
          size="h-9 w-11"
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

/** The person's store key that says the list is put away. */
const LIST_COLLAPSED = "ui/list-collapsed";

/**
 * Puts the page's list away and brings it back, where a page has room for a list beside what is
 * chosen: first in the strip along the top, after the room left for a window's own buttons, and
 * drawn as quietly as Search. With the list away, this, Search and the row of places go with it,
 * and what is chosen has the window; looked at, they are back over the page, and this brings them
 * back for good. Search still opens from its key. The choice is the person's, kept in their store:
 * it is as it was left when the page opens again, away at once as the store answers. Their going
 * and coming is seen only when a person puts the list away, or looks at it.
 */
function Collapse() {
  const collapsed = useCollapsed();
  useEffect(() => {
    void api
      .call<{ value?: unknown }>("store", "get", { key: LIST_COLLAPSED })
      .then(({ value }) => {
        if (value !== true) return;
        setCollapsed(true, true);
        // Once it has been drawn away.
        requestAnimationFrame(() => requestAnimationFrame(settle));
      })
      .catch(() => {});
  }, []);
  const put = (away: boolean) => {
    setCollapsed(away);
    void api.call("store", "set", { key: LIST_COLLAPSED, value: away }).catch(() => {});
  };
  return (
    <div
      data-side
      className={`absolute top-2.5 left-[calc(var(--corner)+10px)] z-10 hidden @min-[56rem]/app:block away:z-40 ${SIDE_PART}`}
    >
      <Place
        label={collapsed ? "Show list" : "Hide list"}
        side="bottom"
        size="size-8"
        current={false}
        aria-expanded={!collapsed}
        onClick={() => put(!collapsed)}
      >
        <PanelLeftIcon className="size-[18px] stroke-[1.5] text-muted-foreground" />
      </Place>
    </div>
  );
}

/**
 * The shell's one bar, where it lies over nothing. Beside what is chosen it is over the foot of the
 * page's list, above the row of places: a list ends well above it. It is no wider than the list, its
 * words cut, so its link and its close stay whole. Where the page holds one thing at a time it is
 * beside the row of places, short of the chat's tab; with the chat open there is no room there, and
 * it is above the places as beside a list, where a page with the chat over it ends well above it.
 * With the list put away it goes with it, and is over the list's foot again while that is looked
 * at. On a phone it has a row of its own along the top, above the page. It holds the plan's notice,
 * once, until it is dismissed (being offline is the notice at the top).
 */
function ShellBar({ notice, dismiss }: Required<Notice>) {
  const chats = useChats();
  const route = useRoute();
  // On the chat page there is no chat in the layer to leave room for.
  const open = chats.open && route.screen !== "chat";
  if (!notice) return null;
  const at = open
    ? "bottom-[calc(var(--foot)+6px)] left-3 max-w-[calc(var(--side)-24px)]"
    : "bottom-2.5 left-[calc(var(--side)+12px)] max-w-[calc(100%-var(--side)-12px-var(--inset)-var(--tab-open)-var(--gap))] @min-[56rem]/app:bottom-[calc(var(--foot)+6px)] @min-[56rem]/app:left-3 @min-[56rem]/app:max-w-[calc(var(--side)-24px)]";
  return (
    <div
      role="status"
      data-side
      className={`window absolute z-20 flex h-10 ${at} items-center gap-3 rounded-full bg-[var(--raised)] pr-1.5 pl-4 text-[13px] shadow-lg away:z-40 ${SIDE_PART} phone:relative phone:inset-auto phone:mx-3 phone:my-2 phone:max-w-none phone:shrink-0`}
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

/** The frame's side, `--side` in styles.css; how near the window's left edge the pointer brings
 * it back over the page, and how far past it the pointer sends it away again. */
const SIDE = 300;
const EDGE = 16;
const PAST = 12;
/** The parts of the frame's left side: its rows, the page's list, and what is marked as one. */
const SIDE_PARTS = 'nav[aria-label="Main"], [data-list], [data-side]';

/**
 * Whether the frame's left side is looked at while the list is put away. A pointer looks at it by
 * coming to the window's left edge, or leaving the window across it, until it goes past the side or
 * out of the window another way. The keyboard looks at it while it is on one of its parts, having
 * come there by a key and not by a press, the button that brings the list back being the first
 * thing Tab comes to. A touch looks at it by a swipe in from the left edge, until a touch past it
 * or another place is gone to.
 */
function usePeek(collapsed: boolean) {
  const route = useRoute();
  const [peek, setPeek] = useState(false);
  const held = useRef({ pointer: false, keys: false, touch: false });
  const say = useRef(() => {});
  say.current = () => setPeek(held.current.pointer || held.current.keys || held.current.touch);
  /** Whether the last thing done was a key, not a press. */
  const keyboard = useRef(false);
  useEffect(() => {
    const key = () => {
      keyboard.current = true;
    };
    const press = () => {
      keyboard.current = false;
      if (!held.current.keys) return;
      held.current.keys = false;
      say.current();
    };
    addEventListener("keydown", key, true);
    addEventListener("pointerdown", press, true);
    return () => {
      removeEventListener("keydown", key, true);
      removeEventListener("pointerdown", press, true);
    };
  }, []);
  useEffect(() => {
    const by = held.current;
    const keyed = (target: EventTarget | null) =>
      keyboard.current && target instanceof Element && !!target.closest(SIDE_PARTS);
    by.pointer = false;
    by.touch = false;
    // Put away from the keyboard, it is still where the keyboard is.
    by.keys = collapsed && keyed(document.activeElement);
    say.current();
    if (!collapsed) return;
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const now = event.clientX <= EDGE ? true : event.clientX > SIDE + PAST ? false : by.pointer;
      if (now === by.pointer) return;
      by.pointer = now;
      say.current();
    };
    const leave = (event: MouseEvent) => {
      by.pointer = event.clientX <= 0;
      say.current();
    };
    const focus = (event: FocusEvent) => {
      by.keys = keyed(event.target);
      say.current();
    };
    const blur = (event: FocusEvent) => {
      if (event.relatedTarget) return;
      by.keys = false;
      say.current();
    };
    /** Where a touch that began at the left edge began. */
    let from: { x: number; y: number } | undefined;
    const touched = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      from = touch.clientX <= EDGE + 8 ? { x: touch.clientX, y: touch.clientY } : undefined;
      if (!by.touch || touch.clientX <= SIDE) return;
      by.touch = false;
      say.current();
    };
    const swiped = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!from || !touch) return;
      const across = touch.clientX - from.x;
      if (across < 30 || across < Math.abs(touch.clientY - from.y)) return;
      from = undefined;
      by.touch = true;
      say.current();
    };
    const root = document.documentElement;
    addEventListener("pointermove", move);
    root.addEventListener("mouseleave", leave);
    addEventListener("focusin", focus);
    addEventListener("focusout", blur);
    addEventListener("touchstart", touched, { passive: true });
    addEventListener("touchmove", swiped, { passive: true });
    return () => {
      removeEventListener("pointermove", move);
      root.removeEventListener("mouseleave", leave);
      removeEventListener("focusin", focus);
      removeEventListener("focusout", blur);
      removeEventListener("touchstart", touched);
      removeEventListener("touchmove", swiped);
    };
  }, [collapsed]);
  // A touch that chose something has what it came for.
  const place = `${route.screen}/${route.agent ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs as the place changes.
  useEffect(() => {
    if (!held.current.touch) return;
    held.current.touch = false;
    say.current();
  }, [place]);
  return peek;
}

function Frame({ notice, dismiss }: Required<Notice>) {
  const route = useRoute();
  const collapsed = useCollapsed();
  const peek = usePeek(collapsed);
  const openedAway = useOpenedAway();
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
          data-collapsed={collapsed || undefined}
          data-peek={peek || undefined}
          data-instant={openedAway || undefined}
          className="@container/app relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-[var(--ground)]"
        >
          <Collapse />
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

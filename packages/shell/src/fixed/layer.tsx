// The layer over the page: one layer across the whole screen, the left bar included, and nothing
// above it. The chat lives in it, at the right, collapsed to a narrow column or open as a panel.
// One inset from the screen's edges places it; nothing in it dims the page, and it closes by its
// own Close.
import { ArchiveIcon, ChevronLeftIcon, MessageCircleIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { api } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { ActivityWindow } from "./activity.tsx";
import { useAllChats } from "./all-chats.tsx";
import { ChatRow, CloseChats } from "./chat-parts.tsx";
import { useChats } from "./chats.tsx";
import { Computer, surfacesOf, windowsOf } from "./computer.tsx";
import { useComputers } from "./computers.tsx";
import { useEvery } from "./data.ts";
import { Face } from "./face.tsx";
import { NewChat, Thread } from "./thread.tsx";
import { useAgents } from "./watch.tsx";

/** How many faces the collapsed chat shows; the count on its button says how many are unread. */
const FACES = 3;
/** The collapsed chat's own measures: its padding, and one icon. Its two widths are the layer's. */
const PAD = 4;
const ICON = 40;

/**
 * The chat collapsed: a narrow column at the right that the layer counts. In it, one pill holding
 * one row of icons, stacked: the chat button at the very right and on top, and behind it the faces
 * of the chats with something unread, each further left and further back. One rule places them:
 * the chat button at the right inner edge, the last face at the left inner edge, the rest evenly
 * between. Under the pointer only the pill's width changes, to one fixed width, leftward and over
 * what's beside it, so the same rule sets the icons a little further apart, still stacked. The room
 * the layer keeps stays the same, so nothing else moves. With nothing unread it is the chat button
 * alone, and doesn't widen. A face opens its chat.
 */
function ChatPill({ returned }: { returned: boolean }) {
  const { expand, openChat } = useChats();
  const unread = useAllChats().chats.filter((chat) => !chat.archived && chat.unread);
  const faces = unread.slice(0, FACES);
  // Closed, the chat hands the keyboard back to the button that opens it.
  const button = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as it takes the panel's place.
  useEffect(() => {
    if (returned) button.current?.focus();
  }, []);
  /** Icon i of the row, the chat button being 0: how far it is from the right inner edge. */
  const at = (i: number) => `calc(${i} * (100% - ${ICON}px) / ${faces.length})`;
  return (
    <div
      data-chat-column
      className="pointer-events-none absolute top-[var(--inset)] right-[var(--inset)] bottom-[var(--inset)] z-50 w-[var(--tab)] phone:z-30"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: the chat's own controls, not a form. */}
      <div
        role="group"
        aria-label="Chats, collapsed"
        style={{ padding: PAD }}
        className={`window pointer-events-auto absolute right-0 bottom-0 overflow-hidden rounded-full bg-[var(--surface)] shadow-xl transition-[width] duration-150 ${faces.length > 0 ? "w-[var(--tab)] hover:w-[var(--tab-open)] has-[:focus-visible]:w-[var(--tab-open)]" : ""}`}
      >
        <div style={{ height: ICON, minWidth: ICON }} className="relative isolate">
          <button
            ref={button}
            type="button"
            aria-label={unread.length > 0 ? `Chats, ${unread.length} new` : "Chats"}
            onClick={expand}
            style={{ width: ICON, height: ICON }}
            className="absolute top-0 right-0 z-10 grid place-items-center rounded-full bg-[var(--raised)] ring-2 ring-[var(--surface)] hover:brightness-110"
          >
            <MessageCircleIcon className="size-5" />
            {unread.length > 0 && (
              <span
                aria-hidden
                className="absolute top-0 right-0 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--unread)] px-1 text-[10px] font-semibold text-white"
              >
                {unread.length}
              </span>
            )}
          </button>
          {faces.length > 0 && (
            <ul aria-label="Unread chats" className="absolute inset-0">
              {faces.map((chat, i) => (
                <li
                  key={`${chat.agent.id} ${chat.entry.id}`}
                  style={{ right: at(i + 1), zIndex: FACES - i }}
                  className="absolute top-0"
                >
                  <button
                    type="button"
                    aria-label={`Open ${chat.entry.title}`}
                    title={chat.entry.title}
                    onClick={() => openChat(chat.agent.id, chat.entry.id)}
                    className="grid rounded-full ring-2 ring-[var(--surface)]"
                  >
                    <Face agent={chat.agent} size={ICON} plain bare />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** The chats, newest first; or the archived ones. */
function Chats({ archived }: { archived: boolean }) {
  const { show, openChat, newChat } = useChats();
  const { chats } = useAllChats();
  const shown = chats.filter((chat) => chat.archived === archived);
  const kept = chats.filter((chat) => chat.archived).length;
  // The ages are read again as time passes.
  useEvery(30_000);
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-1 pr-2.5 pl-4">
        {archived && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ml-2"
            aria-label="All chats"
            onClick={() => show({ kind: "list" })}
          >
            <ChevronLeftIcon />
          </Button>
        )}
        <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold">
          {archived ? "Archived" : "Chats"}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="New chat" onClick={() => newChat()}>
          <SquarePenIcon />
        </Button>
        <CloseChats />
      </header>
      <ul
        aria-label={archived ? "Archived chats" : "Chats"}
        className="no-bar min-h-0 flex-1 overflow-y-auto px-2"
      >
        {shown.map((chat) => (
          <li key={`${chat.agent.id} ${chat.entry.id}`}>
            <ChatRow chat={chat} onOpen={() => openChat(chat.agent.id, chat.entry.id)} />
          </li>
        ))}
      </ul>
      <div className="flex h-12 shrink-0 items-center px-2">
        <Button
          variant="ghost"
          size="sm"
          className={`text-muted-foreground ${archived || kept === 0 ? "invisible" : ""}`}
          onClick={() => show({ kind: "archived" })}
        >
          <ArchiveIcon />
          Archived
          <span className="tabular-nums">{kept}</span>
        </Button>
      </div>
    </>
  );
}

/** The chat as a panel: at the right, the height of the layer, with the page still in use beside it. */
function ChatPanel() {
  const { view } = useChats();
  const { chats } = useAllChats();
  // One chat, one being started, or a list. A chat that is gone, with its agent or not yet
  // listed, shows the list.
  const chat =
    view.kind === "chat"
      ? chats.find((one) => one.agent.id === view.agent && one.entry.id === view.id)
      : undefined;
  const shown = chat ? `${view.kind} ${chat.agent.id} ${chat.entry.id}` : view.kind;
  // The chat takes the keyboard when it opens and when what it shows changes: the button that
  // was pressed is gone.
  const panel = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: again for each thing shown.
  useEffect(() => panel.current?.focus(), [shown]);
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="Chats"
      className="window outline-none absolute top-[var(--inset)] right-[var(--inset)] bottom-[var(--inset)] z-50 flex w-[var(--panel)] flex-col overflow-hidden rounded-3xl bg-background shadow-2xl phone:inset-0 phone:w-auto phone:rounded-none"
    >
      {chat ? (
        <Thread key={shown} chat={chat} />
      ) : view.kind === "new" ? (
        <NewChat key={view.agent ?? "any"} {...(view.agent ? { agent: view.agent } : {})} />
      ) : (
        <Chats archived={view.kind === "archived"} />
      )}
    </aside>
  );
}

/** Where a window ends: one gap short of the chat, at the width the chat has. */
const ROOM = {
  pill: "right-[calc(var(--inset)+var(--tab)+var(--gap))]",
  panel: "right-[calc(var(--inset)+var(--panel)+var(--gap))] narrow:right-[var(--inset)]",
};

/**
 * The layer's parts, over the page: the chat at the right, and to its left a window, an agent's
 * computer or its activity, in the room the chat leaves. Neither moves or resizes the other. Where the open chat
 * leaves a window too little room the two overlap, the one opened last on top; on a phone each
 * takes the screen.
 */
export function Layer() {
  const { open } = useChats();
  const { shown: computer, activity } = useComputers();
  const { byId } = useAgents();
  /** The window's own key: whose it is, and which. */
  const shown = computer ?? (activity && `activity ${activity}`);
  /** Whether the chat has been open: collapsed after that, it is collapsed by its Close. */
  const opened = useRef(false);
  if (open) opened.current = true;
  // Which of the two was opened last, worked out as each opens so neither is drawn under the
  // other first.
  const last = useRef({ open, shown, onTop: "chat" as "chat" | "window" });
  if (open && !last.current.open) last.current.onTop = "chat";
  if (shown && shown !== last.current.shown) last.current.onTop = "window";
  Object.assign(last.current, { open, shown });
  const { onTop } = last.current;
  const owner = computer ? byId.get(computer) : undefined;
  const surfaces = surfacesOf(owner?.detail);
  const doer = activity ? byId.get(activity) : undefined;
  const room = `${ROOM[open ? "panel" : "pill"]} ${onTop === "window" ? "narrow:z-[60]" : ""}`;
  return (
    <>
      {computer && owner && (windowsOf(surfaces).length > 0 || owner.held?.windows) && (
        <Window key={shown} className={room}>
          <Computer
            agent={{ id: computer, name: owner.entry.name, tone: owner.now.tone }}
            surfaces={surfaces}
            onStart={() => api.call("agents", "start", { agent: computer })}
            {...(owner.held?.windows ? { down: owner.held.detail ?? "" } : {})}
            overlay
          />
        </Window>
      )}
      {activity && doer && (
        <Window key={shown} className={room}>
          <ActivityWindow
            agent={{ id: activity, name: doer.entry.name, tone: doer.now.tone }}
            detail={doer.detail}
          />
        </Window>
      )}
      {open ? <ChatPanel /> : <ChatPill returned={opened.current} />}
    </>
  );
}

/** The layer's window. It takes the keyboard when it opens, and gives it back where it was. */
function Window({ className, children }: { className: string; children: React.ReactNode }) {
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const from = document.activeElement;
    group.current?.focus();
    return () => {
      if (from instanceof HTMLElement && from.isConnected) from.focus();
    };
  }, []);
  return (
    // biome-ignore lint/a11y/useSemanticElements: the layer's window, not a form.
    <div
      ref={group}
      tabIndex={-1}
      role="group"
      aria-label="Window"
      className={`absolute top-[var(--inset)] bottom-[var(--inset)] left-[var(--inset)] z-40 flex outline-none ${className} phone:!inset-0 phone:!z-[60]`}
    >
      {children}
    </div>
  );
}

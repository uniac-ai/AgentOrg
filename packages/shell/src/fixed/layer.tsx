// The layer over the page: one layer across the whole screen, the left bar included, and nothing
// above it. The chat lives in it, at the right, collapsed to a narrow column or open as a panel.
// One inset from the screen's edges places it; nothing in it dims the page, and it closes by its
// own Close.
import { ArchiveIcon, ChevronLeftIcon, MessageCircleIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../ui/button.tsx";
import { useAllChats } from "./all-chats.tsx";
import { ChatRow, CloseChats } from "./chat-parts.tsx";
import { useChats } from "./chats.tsx";
import { useEvery } from "./data.ts";
import { Face } from "./face.tsx";
import { NewChat, Thread } from "./thread.tsx";

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

/** The layer's parts, over the page. */
export function Layer() {
  const { open } = useChats();
  /** Whether the chat has been open: collapsed after that, it is collapsed by its Close. */
  const opened = useRef(false);
  if (open) opened.current = true;
  return open ? <ChatPanel /> : <ChatPill returned={opened.current} />;
}

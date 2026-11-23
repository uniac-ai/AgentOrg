// What the chat's views share: a conversation's row, your conversations as a list of them, the
// pinned ones as tiles above the rest, and the control that collapses the chat.
import { CircleAlertIcon, PinIcon, PinOffIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../ui/button.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu.tsx";
import { type ListedChat, useAllChats } from "./all-chats.tsx";
import { useChats } from "./chats.tsx";
import { useEvery } from "./data.ts";
import { Face } from "./face.tsx";

/** How long ago, in the one short form a row has room for. */
export function age(at: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  const days = Math.floor(minutes / (24 * 60));
  return days < 7 ? `${days} d` : `${Math.floor(days / 7)} wk`;
}

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });
/** When something was said, as the person's locale writes it short: today, its time; before today, its date. */
export function timeOf(at: string, now = new Date()): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  return (when.toDateString() === now.toDateString() ? TIME : DATE).format(when);
}

/** Every list of conversations' rows: 4 px apart, so two highlights never touch. */
export const CHAT_ROWS = "flex flex-col gap-1";

/**
 * One conversation in a list: the agent, and its latest message or its problem. One between two
 * agents is shown by the agent it is with, where the other's page lists it. The one open beside the
 * list is marked.
 */
export function ChatRow({
  chat,
  agent = chat.agent,
  current = false,
  onOpen,
}: {
  chat: ListedChat;
  agent?: ListedChat["agent"];
  current?: boolean;
  onOpen(): void;
}) {
  const fresh = chat.unread;
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onOpen}
      className={`flex h-16 w-full items-center gap-3 rounded-xl px-2.5 text-left ${current ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}
    >
      <Face agent={agent} size={40} plain />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[15px] ${fresh ? "font-semibold" : "font-medium"}`}>
          {agent.name}
        </span>
        <span className="flex min-w-0 gap-1.5 text-[13px] text-muted-foreground">
          {/* A conversation has no working state: only an agent works. A row says its problem, or its last words. */}
          {chat.problem ? (
            <span className="truncate text-[var(--bad)]">{chat.problem}</span>
          ) : (
            <span className="truncate">{chat.words}</span>
          )}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5 self-start pt-3">
        <time dateTime={chat.at} className="text-xs whitespace-nowrap text-muted-foreground">
          {timeOf(chat.at)}
        </time>
        <span
          {...(fresh ? { role: "img", "aria-label": "New" } : {})}
          className={`size-2 rounded-full ${fresh ? "bg-[var(--unread)]" : ""}`}
        />
      </span>
    </button>
  );
}

/**
 * A pinned conversation: the agent's face over its name. Of what a row says, it keeps what matters
 * at a glance: that it is the one open, and before its name a mark for its problem, or for
 * something new.
 */
function ChatTile({
  chat,
  current,
  onOpen,
}: {
  chat: ListedChat;
  current: boolean;
  onOpen(): void;
}) {
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onOpen}
      className={`flex w-full flex-col items-center gap-1.5 rounded-xl px-1.5 py-2.5 ${current ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}
    >
      <Face agent={chat.agent} size={48} plain />
      <span className="flex max-w-full items-center gap-1 text-xs">
        {chat.problem ? (
          <CircleAlertIcon
            role="img"
            aria-label={chat.problem}
            className="size-3 shrink-0 text-[var(--bad)]"
          />
        ) : (
          chat.unread && (
            <span
              role="img"
              aria-label="New"
              className="size-2 shrink-0 rounded-full bg-[var(--unread)]"
            />
          )
        )}
        <span className={`truncate ${chat.unread ? "font-semibold" : "font-medium"}`}>
          {chat.agent.name}
        </span>
      </span>
    </button>
  );
}

/**
 * Your conversations. The pinned ones come first, a tile each in a grid, in the order they were
 * pinned; the rest follow, newest first, a row each. `current` is the agent of the one open beside
 * them. A right-click on one, a long press, or Shift+F10 while it has the keyboard, opens its menu:
 * Pin, or Unpin.
 */
export function ChatList({
  chats,
  current,
  onOpen,
  className,
}: {
  chats: ListedChat[];
  current?: string | undefined;
  onOpen(agent: string): void;
  className: string;
}) {
  const { pins, pin } = useAllChats();
  // What was said today is read again when the day changes.
  useEvery(60_000);
  const list = useRef<HTMLUListElement>(null);
  /** The conversation just pinned or unpinned: the keyboard goes with it to where it is drawn now. */
  const moved = useRef<string>(undefined);
  useEffect(() => {
    if (!moved.current) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-chat="${CSS.escape(moved.current)}"] button`)
      ?.focus();
    moved.current = undefined;
  });
  const pinned = pins.flatMap((id) => chats.find((chat) => chat.agent.id === id) ?? []);
  const item = (chat: ListedChat, Shown: typeof ChatTile) => {
    const { id } = chat.agent;
    const isPinned = pins.includes(id);
    return (
      <ContextMenu key={id}>
        <ContextMenuTrigger asChild>
          <li data-chat={id}>
            <Shown chat={chat} current={id === current} onOpen={() => onOpen(id)} />
          </li>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => {
              moved.current = id;
              pin(id, !isPinned);
            }}
          >
            {isPinned ? <PinOffIcon /> : <PinIcon />}
            {isPinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  return (
    <ul ref={list} aria-label="Chats" className={`${CHAT_ROWS} ${className}`}>
      {pinned.length > 0 && (
        <li className="pb-2">
          <ul
            aria-label="Pinned"
            className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1"
          >
            {pinned.map((chat) => item(chat, ChatTile))}
          </ul>
        </li>
      )}
      {chats.filter((chat) => !pins.includes(chat.agent.id)).map((chat) => item(chat, ChatRow))}
    </ul>
  );
}

/** The chat's one control over itself, whatever it shows: it collapses. */
export function CloseChats() {
  const { close } = useChats();
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Close chats" onClick={close}>
      <XIcon />
    </Button>
  );
}

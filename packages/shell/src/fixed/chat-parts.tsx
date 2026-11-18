// What the chat's views share: a conversation's row, your conversations as a list of them, and the
// control that collapses the chat.
import { XIcon } from "lucide-react";
import { Button } from "../ui/button.tsx";
import type { ListedChat } from "./all-chats.tsx";
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

/**
 * One conversation in a list: the agent, and its latest message or its problem. One between two
 * agents is shown by the agent it is with, where the other's page lists it. The one open beside the
 * list is marked. Before your conversation with an agent has begun, its row is the agent alone: its
 * face and its name, with nothing under the name and no time.
 */
export function ChatRow(
  props: (
    | { chat: ListedChat; agent?: ListedChat["agent"] }
    | { chat?: undefined; agent: ListedChat["agent"] }
  ) & { current?: boolean; onOpen(): void },
) {
  const { chat, current = false, onOpen } = props;
  const agent = props.chat ? (props.agent ?? props.chat.agent) : props.agent;
  const fresh = chat?.unread;
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onOpen}
      className={`flex h-[68px] w-full items-center gap-3 rounded-xl px-2.5 text-left hover:bg-[var(--hover)] ${current ? "bg-[var(--selected)]" : ""}`}
    >
      <Face agent={agent} size={40} plain />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[15px] ${fresh ? "font-semibold" : "font-medium"}`}>
          {agent.name}
        </span>
        {chat && (
          <span className="flex min-w-0 gap-1.5 text-[13px] text-muted-foreground">
            {/* A conversation has no working state: only an agent works. A row says its problem, or its last words. */}
            {chat.problem ? (
              <span className="truncate text-[var(--bad)]">{chat.problem}</span>
            ) : (
              <span className="truncate">{chat.words}</span>
            )}
          </span>
        )}
      </span>
      {chat && (
        <span className="flex w-10 shrink-0 flex-col items-end gap-1.5 self-start pt-3.5">
          <span className="text-xs tabular-nums text-muted-foreground">{age(chat.at)}</span>
          <span
            {...(fresh ? { role: "img", "aria-label": "New" } : {})}
            className={`size-2 rounded-full ${fresh ? "bg-[var(--unread)]" : ""}`}
          />
        </span>
      )}
    </button>
  );
}

/**
 * Your conversations, newest first, a row each, and after them the agents in `waiting`, whose
 * conversations haven't begun; `current` is the agent of the one open beside them.
 */
export function ChatList({
  chats,
  waiting = [],
  current,
  onOpen,
  className,
}: {
  chats: ListedChat[];
  waiting?: ListedChat["agent"][];
  current?: string | undefined;
  onOpen(agent: string): void;
  className: string;
}) {
  // The ages are read again as time passes.
  useEvery(30_000);
  return (
    <ul aria-label="Chats" className={className}>
      {chats.map((chat) => (
        <li key={chat.agent.id}>
          <ChatRow
            chat={chat}
            current={chat.agent.id === current}
            onOpen={() => onOpen(chat.agent.id)}
          />
        </li>
      ))}
      {waiting.map((agent) => (
        <li key={agent.id}>
          <ChatRow agent={agent} current={agent.id === current} onOpen={() => onOpen(agent.id)} />
        </li>
      ))}
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

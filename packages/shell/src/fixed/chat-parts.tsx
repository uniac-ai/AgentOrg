// What the chat's views share: a conversation's row in a list, and the control that collapses the chat.
import { XIcon } from "lucide-react";
import { Button } from "../ui/button.tsx";
import type { ListedChat } from "./all-chats.tsx";
import { useChats } from "./chats.tsx";
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

/** One conversation in a list: the agent, and its latest message or its problem. */
export function ChatRow({ chat, onOpen }: { chat: ListedChat; onOpen(): void }) {
  const { agent } = chat;
  const fresh = chat.unread;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-[68px] w-full items-center gap-3 rounded-xl px-2.5 text-left hover:bg-[var(--hover)]"
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
      <span className="flex w-10 shrink-0 flex-col items-end gap-1.5 self-start pt-3.5">
        <span className="text-xs tabular-nums text-muted-foreground">{age(chat.at)}</span>
        <span
          {...(fresh ? { role: "img", "aria-label": "New" } : {})}
          className={`size-2 rounded-full ${fresh ? "bg-[var(--unread)]" : ""}`}
        />
      </span>
    </button>
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

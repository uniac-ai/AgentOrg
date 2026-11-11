// Home is built from chats, since a chat is where anything an agent did can be read. First the
// chats that need you, then the recent ones. There is no list of what agents are doing, and a chat
// has no working state: an agent works, in as many chats as its engine lets it.
import { Button } from "../ui/button.tsx";
import { type ListedChat, useAllChats } from "./all-chats.tsx";
import { ChatRow } from "./chat-parts.tsx";
import { useChats } from "./chats.tsx";
import { useEvery } from "./data.ts";
import { LeftToSetUp } from "./login.tsx";

/** How many recent chats Home shows; the rest are a press away, in the list. */
const RECENT = 6;

export function HomePage() {
  const { chats } = useAllChats();
  const { openChat, show } = useChats();
  // The ages are read again as time passes.
  useEvery(30_000);
  const live = chats.filter((chat) => !chat.archived);
  // A chat needs you when its last message got no answer, or it said something you haven't read.
  const needs = live.filter((chat) => !!chat.problem || chat.unread);
  const recent = live.filter((chat) => !needs.includes(chat)).slice(0, RECENT);
  const rows = (label: string, list: ListedChat[], all = false) =>
    list.length > 0 && (
      <section aria-label={label}>
        <div className="flex h-9 items-center justify-between px-2.5">
          <h2 className="text-[13px] font-medium text-muted-foreground">{label}</h2>
          {all && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => show({ kind: "list" })}
            >
              All
            </Button>
          )}
        </div>
        <ul>
          {list.map((chat) => (
            <li key={`${chat.agent.id} ${chat.entry.id}`}>
              <ChatRow chat={chat} onOpen={() => openChat(chat.agent.id, chat.entry.id)} />
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <div className="no-bar h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[720px] flex-col gap-10 px-4 pt-6 pb-28">
        <LeftToSetUp />
        {rows("Needs you", needs)}
        {rows("Recent", recent, true)}
      </div>
    </div>
  );
}

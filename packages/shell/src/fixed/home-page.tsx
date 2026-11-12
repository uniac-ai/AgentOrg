// Home is built from chats, since a chat is where anything an agent did can be read. First the
// chats that need you, then the recent ones. There is no list of what agents are doing, and a chat
// has no working state: an agent works, in as many chats as its engine lets it.
import { Button } from "../ui/button.tsx";
import { type ListedChat, useAllChats } from "./all-chats.tsx";
import { useBuilding } from "./building.tsx";
import { ChatRow } from "./chat-parts.tsx";
import { useChats } from "./chats.tsx";
import { useEvery } from "./data.ts";
import { LeftToSetUp } from "./login.tsx";
import { Nothing, UNREAD } from "./parts.tsx";
import { useAgents } from "./watch.tsx";

/** How many recent chats Home shows; the rest are a press away, in the list. */
const RECENT = 6;

const heading = "text-[13px] font-medium text-muted-foreground";

export function HomePage() {
  const { chats, listed } = useAllChats();
  const agents = useAgents();
  const { openChat, show } = useChats();
  const building = useBuilding();
  // The ages are read again as time passes.
  useEvery(30_000);
  const live = chats.filter((chat) => !chat.archived);
  // A chat needs you when its last message got no answer, or it said something you haven't read.
  const needs = live.filter((chat) => !!chat.problem || chat.unread);
  const recent = live.filter((chat) => !needs.includes(chat)).slice(0, RECENT);
  const nothing = agents.unread
    ? UNREAD
    : !agents.loaded || live.length > 0
      ? undefined
      : agents.list.length === 0
        ? "No agents"
        : listed
          ? "No chats"
          : undefined;
  const rows = (label: string, list: ListedChat[], all = false) =>
    list.length > 0 && (
      <section aria-label={label}>
        <div className="flex h-9 items-center justify-between px-2.5">
          <h2 className={heading}>{label}</h2>
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
        {/* With nothing to list, Recent says which nothing it is: none yet, or none that can be read. */}
        {nothing && (
          <section aria-label="Recent">
            <div className="flex h-9 items-center px-2.5">
              <h2 className={heading}>Recent</h2>
            </div>
            <div className="flex items-center gap-4 px-2.5">
              <Nothing>{nothing}</Nothing>
              {nothing === "No agents" && (
                <Button className="h-8 rounded-full px-4" onClick={building.show}>
                  Create
                </Button>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// The chat page: a place of its own for messages. Your conversations at the left, newest first, and
// the open one beside them at the page's full height, drawn as the chat draws it. Where there is no
// room for both, the list comes first and a conversation takes its place, with a way back.
import { useRef } from "react";
import { go } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { useAllChats } from "./all-chats.tsx";
import { useBuilding } from "./building.tsx";
import { ChatList } from "./chat-parts.tsx";
import { Nothing, UNREAD } from "./parts.tsx";
import { useSplit } from "./split.ts";
import { Thread } from "./thread.tsx";
import { useAgents } from "./watch.tsx";

export function ChatPage({ agent }: { agent?: string | undefined }) {
  const { chats, listed } = useAllChats();
  const agents = useAgents();
  const building = useBuilding();
  const [ref, split] = useSplit<HTMLDivElement>();
  // Wide, it opens on the most recent conversation and stays on it while others get replies.
  const first = useRef<string | undefined>(undefined);
  if (!first.current || !chats.some((chat) => chat.agent.id === first.current))
    first.current = chats[0]?.agent.id;
  // An address naming an agent opens your conversation with it; one that isn't there, the list.
  const named = agent && agents.byId.has(agent) ? agent : undefined;
  const open = named ?? (split ? first.current : undefined);
  const watched = open ? agents.byId.get(open) : undefined;
  const listing = split || !watched;
  // With nothing to list, it says which nothing it is.
  const nothing = agents.unread
    ? UNREAD
    : !agents.loaded || chats.length > 0
      ? undefined
      : agents.list.length === 0
        ? "No agents"
        : listed
          ? "No chats"
          : undefined;
  return (
    <div ref={ref} className="flex h-full min-h-0">
      {listing && (
        <section
          aria-label="Chats"
          className={`flex min-h-0 flex-col ${split ? "w-[320px] shrink-0 border-r" : "min-w-0 flex-1"}`}
        >
          <header className="flex h-14 shrink-0 items-center px-4">
            <h1 className="text-[17px] font-semibold">Chats</h1>
          </header>
          {chats.length > 0 && (
            <ChatList
              chats={chats}
              current={split ? open : undefined}
              onOpen={(id) => go({ screen: "chat", agent: id })}
              className="no-bar min-h-0 flex-1 overflow-y-auto px-2 pb-24"
            />
          )}
          {nothing && (
            <div className="flex items-center gap-4 px-4">
              <Nothing>{nothing}</Nothing>
              {nothing === "No agents" && (
                <Button className="h-8 rounded-full px-4" onClick={building.show}>
                  Create
                </Button>
              )}
            </div>
          )}
        </section>
      )}
      {open && watched && (
        <section
          aria-label={`Conversation with ${watched.entry.name}`}
          className="flex min-w-0 flex-1 flex-col"
        >
          <Thread
            key={open}
            agent={{ id: open, name: watched.entry.name, tone: watched.now.tone }}
            chat={chats.find((chat) => chat.agent.id === open)}
            page={split ? {} : { back: () => go({ screen: "chat" }) }}
          />
        </section>
      )}
    </div>
  );
}

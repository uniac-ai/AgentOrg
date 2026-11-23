// The chat page: a place of its own for messages. Your conversations at the left, newest first, and
// the open one beside them in a card at the page's full height, drawn as the chat draws it. Where
// there is no room for both, the list comes first and a conversation takes its place, with a way
// back. Wide, an agent's computer opens in a card of its own beside the conversation's rather than
// over the page. The list is your conversations only: at the first start, before any has begun, it
// says it has none, and the first agent's conversation is open, empty, wide and on a phone. The
// plus at the end of the list's label picks who to message, and opens that agent's conversation,
// empty if none has begun.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, go } from "../data.ts";
import { useAllChats } from "./all-chats.tsx";
import { ChatList } from "./chat-parts.tsx";
import { Compose } from "./compose.tsx";
import { Computer, hasComputer, surfacesOf } from "./computer.tsx";
import { useComputers } from "./computers.tsx";
import { ListHead, ListPanel, PAGE_CARD } from "./page-frame.tsx";
import { Nothing, UNREAD } from "./parts.tsx";
import { useCollapsed, useSplit } from "./split.ts";
import { Thread } from "./thread.tsx";
import { useAgents } from "./watch.tsx";

export function ChatPage({ agent }: { agent?: string | undefined }) {
  const { chats, listed } = useAllChats();
  const agents = useAgents();
  const [ref, split, width] = useSplit<HTMLDivElement>();
  // Wide, the open computer is shown here, beside the conversation, and not in the layer.
  const { showOnPage } = useComputers();
  useLayoutEffect(() => {
    showOnPage(split);
    return () => showOnPage(false);
  }, [split, showOnPage]);
  // The first start: while no conversation has begun at all, once that is known, the first agent's
  // conversation is open, empty. Its row comes with its first message.
  const fresh = listed && chats.length === 0 && !agents.unread ? agents.list[0]?.agent : undefined;
  // On a phone, its way back is to the list, which says it has none.
  const [back, setBack] = useState(false);
  const [composing, setComposing] = useState(false);
  // Wide, it opens on the most recent conversation and stays on it while others get replies; at the
  // first start, on the first agent's.
  const first = useRef<string | undefined>(undefined);
  if (!first.current || !chats.some((chat) => chat.agent.id === first.current))
    first.current = chats[0]?.agent.id;
  // An address naming an agent opens your conversation with it; one that isn't there, the list.
  const named = agent && agents.byId.has(agent) ? agent : undefined;
  const open = named ?? (split ? (first.current ?? fresh) : back ? undefined : fresh);
  const watched = open ? agents.byId.get(open) : undefined;
  // Put away, the list is shown only while nothing is open.
  const collapsed = useCollapsed();
  const listing = (split && !collapsed) || !watched;
  // With nothing to list, it says so: the same words whether or not there are agents, and no way to
  // make one here. Agents that can't be read say that.
  const nothing = agents.unread ? UNREAD : listed && chats.length === 0 ? "No chats" : undefined;
  return (
    <div ref={ref} className="flex h-full min-h-0">
      {listing && (
        <ListPanel label="Chats">
          <ListHead label="Chats" add="Message" onAdd={() => setComposing(true)} />
          {chats.length > 0 && (
            <ChatList
              chats={chats}
              current={split ? open : undefined}
              onOpen={(id) => go({ screen: "chat", agent: id })}
              className="no-bar min-h-0 flex-1 overflow-y-auto px-2 pb-24"
            />
          )}
          {nothing && (
            <div className="flex items-center gap-4 px-[18px]">
              <Nothing>{nothing}</Nothing>
            </div>
          )}
        </ListPanel>
      )}
      {open && watched && (
        <section
          aria-label={`Conversation with ${watched.entry.name}`}
          className={`flex flex-1 flex-col ${PAGE_CARD}`}
        >
          <Thread
            key={open}
            agent={{ id: open, name: watched.entry.name, tone: watched.now.tone }}
            chat={chats.find((chat) => chat.agent.id === open)}
            page={
              split
                ? {}
                : {
                    back: () => {
                      setBack(true);
                      go({ screen: "chat" });
                    },
                  }
            }
          />
        </section>
      )}
      {split && <Beside room={width} />}
      <Compose open={composing} onOpenChange={setComposing} />
    </div>
  );
}

/** The sidebar's width: what the page has beyond its list, a conversation of 468 and the 12 beside the cards, within 480 to 720. */
export const besideWidth = (page: number) => Math.min(720, Math.max(480, page - 780));

/**
 * The open computer beside the conversation. It grows from the page's right edge as it opens, the
 * conversation narrowing with it, while the computer slides in and fades in; it closes the same way
 * back, and keeps the computer it shows until it has gone. Its times are the page's window times.
 */
function Beside({ room }: { room: number }) {
  const { shown } = useComputers();
  const { byId } = useAgents();
  const owner = shown ? byId.get(shown) : undefined;
  const there = owner && hasComputer(owner.detail, !!owner.held?.windows) ? shown : undefined;
  /** The computer drawn: kept while it closes. */
  const [drawn, setDrawn] = useState(there);
  const [open, setOpen] = useState(false);
  const side = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (there) {
      setDrawn(there);
      // Drawn closed for a frame first, so its opening is seen.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setOpen(true));
      });
      return () => cancelAnimationFrame(frame);
    }
    setOpen(false);
  }, [there]);
  // Closed, it goes once its closing has run: as long as its styles say, or at once.
  useEffect(() => {
    if (open || there || !drawn || !side.current) return;
    const ms = Number.parseFloat(getComputedStyle(side.current).transitionDuration) * 1000;
    const gone = setTimeout(() => setDrawn(undefined), ms || 0);
    return () => clearTimeout(gone);
  }, [open, there, drawn]);
  const agent = drawn ? byId.get(drawn) : undefined;
  if (!drawn || !agent) return null;
  const wide = besideWidth(room);
  const motion = open
    ? "duration-[var(--window-open)] ease-out"
    : "duration-[var(--window-close)] ease-in";
  return (
    <div
      ref={side}
      data-beside={open ? "open" : "closed"}
      style={{ width: open ? wide : 0 }}
      className={`shrink-0 transition-[width,margin] motion-reduce:duration-0 ${PAGE_CARD} wide:ml-0 ${open ? "" : "wide:mr-0 border-transparent"} ${motion}`}
    >
      <div
        style={{ width: wide }}
        className={`flex h-full p-3 transition-[opacity,translate] motion-reduce:duration-0 ${open ? "translate-x-0 opacity-100" : "translate-x-6 opacity-0"} ${motion}`}
      >
        <Computer
          agent={{ id: drawn, name: agent.entry.name, tone: agent.now.tone }}
          surfaces={surfacesOf(agent.detail)}
          onStart={() => api.call("agents", "start", { agent: drawn })}
          {...(agent.held?.windows ? { down: agent.held.detail ?? "" } : {})}
          overlay
          beside
        />
      </div>
    </div>
  );
}

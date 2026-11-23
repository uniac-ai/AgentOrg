// The chat page: a place of its own for messages. Your conversations at the left, newest first, and
// the open one beside them in a card at the page's full height, drawn as the chat draws it. Where
// there is no room for both, the list comes first and a conversation takes its place, with a way
// back. Wide, an agent's computer opens in a card of its own beside the conversation's rather than
// over the page, and its details open there from its face: one of the two at a time, the one
// opened last. The list is your conversations only: at the first start, before any has begun, it
// says it has none, and the first agent's conversation is open, empty, wide and on a phone. The
// plus at the end of the list's label picks who to message, and opens that agent's conversation,
// empty if none has begun.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../cn.ts";
import { api, go } from "../data.ts";
import { AgentDetails } from "./agent-details.tsx";
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
  const { showOnPage, shown, close } = useComputers();
  useLayoutEffect(() => {
    showOnPage(split);
    return () => showOnPage(false);
  }, [split, showOnPage]);
  // What the page has beyond what it keeps beside its sidebar: its list, unless that is put away,
  // and a conversation.
  const collapsed = useCollapsed();
  const beyond = width - (collapsed ? 0 : LIST) - CONVERSATION;
  // Its agent's details are shown there too, in the computer's place, which a computer opened after
  // them takes. The face opens and closes them where the page has room for their column.
  const [detailed, setDetailed] = useState(false);
  if (detailed && shown) setDetailed(false);
  const details =
    beyond >= DETAILS
      ? () => {
          setDetailed(!detailed);
          if (shown) close();
        }
      : undefined;
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
                ? { details }
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
      {split && (
        <Beside
          room={beyond}
          details={detailed && details ? open : undefined}
          onClose={() => setDetailed(false)}
        />
      )}
      <Compose open={composing} onOpenChange={setComposing} />
    </div>
  );
}

/** The list beside what is chosen: `--side` in styles.css. */
const LIST = 300;
/** A conversation's own room beside its sidebar, 468, with the 12 beside and between the cards. */
const CONVERSATION = 480;
/** The computer's sidebar: what the page has beyond what it keeps, within 480 to 720. */
const COMPUTER = [480, 720] as const;
/** An agent's details are a column, not a place to work in. */
const DETAILS = 360;

/**
 * What is open beside the conversation, in a card of its own: an agent's details, on a ground a
 * step off the conversation's, or else the open computer. It grows from the page's right edge as it
 * opens, the conversation narrowing with it, while what it shows slides in and fades in; it closes
 * the same way back, and keeps what it shows until it has gone. One takes the other's place as it
 * is, at its own width. Its times are the page's window times.
 */
function Beside({
  room,
  details,
  onClose,
}: {
  /** What the page has beyond what it keeps. */
  room: number;
  /** The agent whose details are open, and what closes them. */
  details: string | undefined;
  onClose(): void;
}) {
  const { shown } = useComputers();
  const { byId } = useAgents();
  const owner = shown ? byId.get(shown) : undefined;
  const computer = owner && hasComputer(owner.detail, !!owner.held?.windows) ? shown : undefined;
  /** Whose it is, and which of the two. */
  const there = details ?? computer;
  const detailed = !!details;
  /** What is drawn: kept while it closes. */
  const [drawn, setDrawn] = useState(there ? { agent: there, detailed } : undefined);
  const [open, setOpen] = useState(false);
  const side = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (there) {
      setDrawn({ agent: there, detailed });
      // Drawn closed for a frame first, so its opening is seen.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setOpen(true));
      });
      return () => cancelAnimationFrame(frame);
    }
    setOpen(false);
  }, [there, detailed]);
  // Closed, it goes once its closing has run: as long as its styles say, or at once.
  useEffect(() => {
    if (open || there || !drawn || !side.current) return;
    const ms = Number.parseFloat(getComputedStyle(side.current).transitionDuration) * 1000;
    const gone = setTimeout(() => setDrawn(undefined), ms || 0);
    return () => clearTimeout(gone);
  }, [open, there, drawn]);
  const agent = drawn ? byId.get(drawn.agent) : undefined;
  if (!drawn || !agent) return null;
  const wide = drawn.detailed ? DETAILS : Math.min(COMPUTER[1], Math.max(COMPUTER[0], room));
  const motion = open
    ? "duration-[var(--window-open)] ease-out"
    : "duration-[var(--window-close)] ease-in";
  return (
    <div
      ref={side}
      data-beside={open ? "open" : "closed"}
      style={{ width: open ? wide : 0 }}
      className={cn(
        "shrink-0 transition-[width,margin] motion-reduce:duration-0",
        PAGE_CARD,
        "wide:ml-0",
        drawn.detailed && "bg-[var(--aside)]",
        !open && "wide:mr-0 border-transparent",
        motion,
      )}
    >
      {/* As wide as the card is inside its line, while the card grows around it. */}
      <div
        style={{ width: wide - 2 }}
        className={`flex h-full p-3 transition-[opacity,translate] motion-reduce:duration-0 ${open ? "translate-x-0 opacity-100" : "translate-x-6 opacity-0"} ${motion}`}
      >
        {drawn.detailed ? (
          <AgentDetails agent={drawn.agent} onClose={onClose} />
        ) : (
          <Computer
            agent={{ id: drawn.agent, name: agent.entry.name, tone: agent.now.tone }}
            surfaces={surfacesOf(agent.detail)}
            onStart={() => api.call("agents", "start", { agent: drawn.agent })}
            {...(agent.held?.windows ? { down: agent.held.detail ?? "" } : {})}
            overlay
            beside
          />
        )}
      </div>
    </div>
  );
}

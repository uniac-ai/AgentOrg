// One chat, over its agent's `chat@1`: a title, one agent, its messages; and a chat about to be
// started. The record is the chat's and whether it works is the agent's. A chat stops nothing and
// chooses no model: those are the agent's, on its page.
import { NotConnected } from "@agentorg/sdk";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  CopyIcon,
  MoreHorizontalIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import { api, go, useConnection } from "../data.ts";
import { Bubble, BubbleContent } from "../ui/bubble.tsx";
import { Button } from "../ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "../ui/input-group.tsx";
import { Marker, MarkerContent } from "../ui/marker.tsx";
import { Message, MessageContent, MessageFooter } from "../ui/message.tsx";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "../ui/message-scroller.tsx";
import { type ListedChat, useAllChats } from "./all-chats.tsx";
import { CallRow } from "./call-row.tsx";
import { type Row, rowsOf } from "./calls.ts";
import { ChatRow, CloseChats } from "./chat-parts.tsx";
import { useChats } from "./chats.tsx";
import { type ChatMessage, type ChatStatus, reasonOf } from "./data.ts";
import { Face } from "./face.tsx";
import { openUsage, remedyOf } from "./notice.ts";
import { useAgents } from "./watch.tsx";

const PAGE = 100;

/** A message the person sent that the record doesn't have yet; `messageId` once `send` says it. */
interface Sending {
  id: string;
  text: string;
  messageId?: string;
}

/** What the thread shows: each message of the person, then what the agent did and said. */
type Turn =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; parts: Part[] };
type Part =
  | { kind: "tool"; message: ChatMessage }
  | { kind: "text"; id: string; text: string; streaming?: boolean };

function turnsOf(
  messages: readonly ChatMessage[],
  unrecorded: readonly Sending[],
  streaming: ReadonlyMap<string, string>,
  keys: ReadonlyMap<string, string>,
): Turn[] {
  const turns: Turn[] = [];
  const agentTurn = (id: string) => {
    const last = turns.at(-1);
    if (last?.kind === "agent") return last;
    const turn: Turn = { kind: "agent", id, parts: [] };
    turns.push(turn);
    return turn;
  };
  for (const message of messages) {
    if (message.role === "user")
      turns.push({ kind: "user", id: keys.get(message.id) ?? message.id, text: message.text });
    else if (message.role === "tool") agentTurn(message.id).parts.push({ kind: "tool", message });
    else agentTurn(message.id).parts.push({ kind: "text", id: message.id, text: message.text });
  }
  for (const { id, text } of unrecorded) turns.push({ kind: "user", id, text });
  for (const [id, text] of streaming)
    agentTurn(id).parts.push({ kind: "text", id, text, streaming: true });
  return turns;
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
}

/** Where a message is written, and nothing else. What's half typed waits there, in this session. */
function Composer({
  name,
  draft,
  onSend,
}: {
  name: string;
  /** Whose half-typed text this is: a chat's, or a chat about to be started with an agent. */
  draft: string;
  /** Sends it; false when it wasn't taken, and the text stays. */
  onSend(text: string): Promise<boolean>;
}) {
  const { drafts } = useChats();
  const [text, setTextState] = useState(drafts.get(draft) ?? "");
  const setText = (value: string) => {
    drafts.set(draft, value);
    setTextState(value);
  };
  const submit = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    // Not taken, it is back in the box unless something else was typed meanwhile.
    if (!(await onSend(body)) && !drafts.get(draft)) setText(body);
  };
  return (
    <InputGroup className="rounded-3xl border-0 bg-[var(--raised)] shadow-none">
      <InputGroupTextarea
        aria-label="Message"
        placeholder={`Message ${name}`}
        className="min-h-14 px-4 pt-3.5 text-[15px]"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <InputGroupAddon align="block-end" className="gap-1 px-2.5 pb-2.5">
        <InputGroupButton
          size="icon-sm"
          variant="default"
          className="ml-auto shrink-0 rounded-full"
          aria-label="Send"
          disabled={!text.trim()}
          onClick={() => void submit()}
        >
          <ArrowUpIcon />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

/** What went wrong, in the one line a chat says it in; and what helps, where something does. */
const ProblemLine = ({
  children,
  fix,
}: {
  children: string;
  fix?: { label: string; run(): void } | undefined;
}) => (
  <div role="alert" className="flex h-8 items-center gap-3 text-[15px] text-[var(--bad)]">
    <span className="min-w-0 truncate">{children}</span>
    {fix && (
      <Button variant="secondary" size="sm" className="shrink-0" onClick={fix.run}>
        {fix.label}
      </Button>
    )}
  </div>
);

/** A chat about to be started: who with, and the first thing said. It exists once that's sent. */
export function NewChat({ agent: preset }: { agent?: string }) {
  const { show, openChat } = useChats();
  const { list, byId } = useAgents();
  const { chats } = useAllChats();
  const [picked, setPicked] = useState(preset);
  const [refused, setRefused] = useState<string>();
  /** The chat the first message made: it is opened once the list has it. */
  const [started, setStarted] = useState<{ agent: string; id: string }>();
  const listed =
    started && chats.some((c) => c.agent.id === started.agent && c.entry.id === started.id);
  useEffect(() => {
    if (started && listed) openChat(started.agent, started.id);
  }, [started, listed, openChat]);
  const off = (id: string) => byId.get(id)?.entry.status.state === "stopped";
  const agent = picked && !off(picked) ? byId.get(picked) : undefined;
  const earlier = agent
    ? chats
        .filter((chat) => chat.agent.id === agent.entry.agent && !chat.entry.archived)
        .slice(0, 3)
    : [];
  /** A first message is on its way: a second would start a second chat. */
  const starting = useRef(false);
  const send = async (text: string) => {
    if (!agent?.slot || starting.current) return false;
    setRefused(undefined);
    starting.current = true;
    try {
      const sent = await api.call<{ chat: string }>(agent.slot, "send", { text });
      setStarted({ agent: agent.entry.agent, id: sent.chat });
      return true;
    } catch (error) {
      starting.current = false;
      setRefused(reasonOf(error));
      return false;
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 pr-2.5 pl-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="All chats"
          onClick={() => show({ kind: "list" })}
        >
          <ChevronLeftIcon />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold">New chat</h2>
        <CloseChats />
      </header>
      <div className="no-bar mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col overflow-y-auto px-4">
        <ul aria-label="Who with" className="no-bar flex shrink-0 gap-1 overflow-x-auto py-3">
          {list.map((one) => {
            const watched = byId.get(one.agent);
            return (
              <li key={one.agent}>
                <button
                  type="button"
                  aria-pressed={one.agent === agent?.entry.agent}
                  disabled={off(one.agent)}
                  onClick={() => {
                    setPicked(one.agent);
                    setRefused(undefined);
                  }}
                  className={`flex w-[84px] flex-col items-center gap-2 rounded-2xl px-1 py-2.5 enabled:hover:bg-[var(--hover)] disabled:text-muted-foreground ${one.agent === agent?.entry.agent ? "bg-[var(--selected)]" : ""}`}
                >
                  <Face
                    agent={{ id: one.agent, name: one.name, tone: watched?.now.tone ?? "idle" }}
                    size={48}
                  />
                  <span className="w-full truncate text-center text-[13px]">{one.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {earlier.length > 0 && agent && (
          <ul aria-label={`Earlier chats with ${agent.entry.name}`} className="mt-2">
            {earlier.map((chat) => (
              <li key={chat.entry.id}>
                <ChatRow chat={chat} onOpen={() => openChat(chat.agent.id, chat.entry.id)} />
              </li>
            ))}
          </ul>
        )}
        {refused && <ProblemLine>{refused}</ProblemLine>}
      </div>
      <div className="mx-auto w-full max-w-[720px] shrink-0 px-3 pb-3">
        {agent ? (
          <Composer name={agent.entry.name} draft={`new ${agent.entry.agent}`} onSend={send} />
        ) : (
          <div className="h-[104px] rounded-3xl bg-[var(--raised)]" />
        )}
      </div>
    </div>
  );
}

/** One chat: its head, what was said in it, and where the next thing is written. */
export function Thread({ chat }: { chat: ListedChat }) {
  const { show, close } = useChats();
  const { byId } = useAgents();
  const { read } = useAllChats();
  const connection = useConnection();
  const reduced = useReducedMotion();
  const { agent, entry } = chat;
  const id = entry.id;
  const watched = byId.get(agent.id);
  const slot = watched?.slot;
  // A stopped agent's chat is for reading: it has no composer until the agent starts.
  const state = watched?.entry.status.state;
  const off = state === "stopped";
  /** The record, in order, and the text still streaming by id. */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<ReadonlyMap<string, string>>(new Map());
  /** Whether the agent works, in this chat or another. */
  const [working, setWorking] = useState(false);
  /** A call of this thread's that failed; one that was a read ends with a good read. */
  const [failure, setFailure] = useState<{ said: string; read?: boolean }>();
  /** What the person sent, shown at once, until the record has it. */
  const [sending, setSending] = useState<readonly Sending[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  // What the async reads below merge into: always the latest.
  const shown = useRef(messages);
  shown.current = messages;
  const sends = useRef(0);
  /** A recorded message's key in the thread: the one it was shown under at once, so it stays. */
  const keys = useRef(new Map<string, string>());
  /** The title as it is being typed, while the chat is renamed. */
  const [naming, setNaming] = useState<string>();
  /** Changes what the chat is called or where it is listed: its entry says so when it's done. */
  const change = (method: "rename" | "archive", input: object) => {
    if (!slot) return;
    setFailure(undefined);
    api.call(slot, method, { chat: id, ...input }).catch((error: unknown) => {
      leaving.current = false;
      setFailure({ said: reasonOf(error) });
    });
  };
  // Archived from here, it leaves for the archived ones once its entry says so: the list is
  // shown, and what was new in it is read. Refused, it stays, and says why.
  const leaving = useRef(false);
  useEffect(() => {
    if (!leaving.current || !entry.archived) return;
    if (entry.latest) read(agent.id, id, entry.latest.at);
    show({ kind: "list" });
  }, [entry.archived, entry.latest, read, show, agent.id, id]);
  const renaming = useRef(false);
  const rename = () => {
    const title = naming?.trim();
    if (title && title !== entry.title) change("rename", { title });
    setNaming(undefined);
  };

  // A reply cut off by a problem never settles: it goes.
  const failed = !!entry.problem;
  useEffect(() => {
    if (failed) setStreaming(new Map());
  }, [failed]);
  // A reply shown here is read.
  const replied = messages.findLast((m) => m.role === "assistant")?.at;
  useEffect(() => {
    if (replied) read(agent.id, id, replied);
  }, [read, agent.id, id, replied]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` says when to read again.
  useEffect(() => {
    if (connection !== "open" || !slot) return;
    let live = true;
    const here = (payload: unknown) => (payload as { chat: string }).chat === id;
    /**
     * The record and the status now. The record outranks what streamed, and only what arrives
     * while the page is read is newer than it.
     */
    /** Whether the status was said while the record was being read: that is the newer word. */
    let heard = false;
    const load = async () => {
      const since = shown.current.length;
      heard = false;
      try {
        const [{ messages: page, more }, now] = await Promise.all([
          api.call<{ messages: ChatMessage[]; more: boolean }>(slot, "history", {
            chat: id,
            limit: PAGE,
          }),
          // The status is the agent's.
          api.call<ChatStatus>(slot, "state", {}),
        ]);
        if (!live) return;
        const known = new Set(page.map((m) => m.id));
        setMessages([...page, ...shown.current.slice(since).filter((m) => !known.has(m.id))]);
        setHasEarlier(more);
        // A reply that settled while nothing was heard is in the record: its partial text goes.
        setStreaming((was) => {
          const left = new Map([...was].filter(([reply]) => !known.has(reply)));
          return left.size === was.size ? was : left;
        });
        if (!heard) setWorking(now.state === "working");
        setFailure((was) => (was?.read ? undefined : was));
      } catch (error) {
        if (live && !(error instanceof NotConnected))
          setFailure({ said: reasonOf(error), read: true });
      }
    };
    const stops = [
      api.subscribe(
        slot,
        "message",
        (payload) => {
          if (!here(payload)) return;
          const message = payload as ChatMessage;
          setStreaming((was) => {
            if (!was.has(message.id)) return was;
            const next = new Map(was);
            next.delete(message.id);
            return next;
          });
          // The record has what the person sent: it takes the place of the one shown at once.
          if (message.role === "user")
            setSending((was) => {
              const at = was.findIndex((m) => m.text === message.text);
              const taken = was[at];
              if (!taken) return was;
              keys.current.set(message.id, taken.id);
              return was.filter((_, i) => i !== at);
            });
          // The latest word on an id replaces the earlier: a tool call running, then ended.
          setMessages((was) => {
            const at = was.findIndex((m) => m.id === message.id);
            return at === -1 ? [...was, message] : was.map((m, i) => (i === at ? message : m));
          });
        },
        { again: load },
      ),
      api.subscribe(
        slot,
        "delta",
        (payload) => {
          if (!here(payload)) return;
          const { id: reply, text: piece } = payload as { id: string; text: string };
          // A late piece of a reply already settled changes nothing.
          if (shown.current.some((m) => m.id === reply)) return;
          setStreaming((was) => new Map(was).set(reply, (was.get(reply) ?? "") + piece));
        },
        { again: load },
      ),
      api.subscribe(
        slot,
        "status",
        (payload) => {
          const status = payload as ChatStatus;
          heard = true;
          setWorking(status.state === "working");
          // What went wrong on this page is over once the agent works again.
          if (status.state === "working") setFailure(undefined);
          // A reply cut off when the agent was stopped never settles: it goes.
          if (status.state === "idle") setStreaming(new Map());
        },
        { again: load },
      ),
    ];
    void load();
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, [slot, id, connection, state]);

  const recorded = new Set(messages.map((m) => m.id));
  const unrecorded = sending.filter((m) => !m.messageId || !recorded.has(m.messageId));
  // A chat awaits a reply while the newest thing said in it is the person's and the agent works.
  // Until the record has what was sent, "Thinking" never drops out between the two.
  const asked = messages.findLast((m) => m.role !== "tool")?.role === "user";
  const awaiting = unrecorded.length > 0 || (working && asked);
  // While it awaits a reply its problem is not said: the reply ends it, or it is said again. A
  // call of this thread's that failed is said in its place.
  const problem = failure || awaiting ? undefined : entry.problem;
  const wrong = failure?.said ?? problem?.message;
  // A problem that the plan's page can fix ends its line with the way there. Signing in isn't
  // offered from the line.
  const remedy = problem && remedyOf(problem);
  const fix = remedy?.run === "manage" ? { label: remedy.label, run: openUsage } : undefined;
  const rows = useMemo(() => new Map(rowsOf(messages).map((row) => [row.id, row])), [messages]);
  const turns = useMemo(
    () => turnsOf(messages, unrecorded, streaming, keys.current),
    [messages, unrecorded, streaming],
  );
  const lastTurn = turns.at(-1);
  const toolRunning = messages.at(-1)?.tool?.state === "running";
  const thinking = awaiting && streaming.size === 0 && !toolRunning;

  const send = async (text: string) => {
    if (!slot) return false;
    setFailure(undefined);
    const key = `sending-${++sends.current}`;
    setSending((was) => [...was, { id: key, text }]);
    try {
      const { messageId } = await api.call<{ messageId: string }>(slot, "send", { chat: id, text });
      keys.current.set(messageId, key);
      setSending((was) => was.map((m) => (m.id === key ? { ...m, messageId } : m)));
      return true;
    } catch (error) {
      setSending((was) => was.filter((m) => m.id !== key));
      setFailure({ said: reasonOf(error) });
      return false;
    }
  };
  const earlier = async () => {
    const oldest = shown.current[0];
    if (!oldest || !slot) return;
    try {
      const { messages: page, more } = await api.call<{
        messages: ChatMessage[];
        more: boolean;
      }>(slot, "history", { chat: id, before: oldest.id, limit: PAGE });
      setMessages((was) => {
        const known = new Set(was.map((m) => m.id));
        return [...page.filter((m) => !known.has(m.id)), ...was];
      });
      setHasEarlier(more);
      setFailure(undefined);
    } catch (error) {
      setFailure({ said: reasonOf(error) });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 pr-2.5 pl-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="All chats"
          onClick={() => show({ kind: "list" })}
        >
          <ChevronLeftIcon />
        </Button>
        <button
          type="button"
          aria-label={`${agent.name}'s page`}
          className="shrink-0 rounded-full"
          onClick={() => {
            go({ screen: "agent", agent: agent.id });
            close();
          }}
        >
          <Face agent={agent} size={36} />
        </button>
        <div className="ml-1.5 min-w-0 flex-1">
          {naming === undefined ? (
            <h2 className="truncate text-[15px] leading-5 font-semibold">{entry.title}</h2>
          ) : (
            <input
              aria-label="Chat title"
              // biome-ignore lint/a11y/noAutofocus: it is there because Rename was just pressed.
              autoFocus
              value={naming}
              onChange={(event) => setNaming(event.target.value)}
              onBlur={rename}
              onKeyDown={(event) => {
                if (event.key === "Enter") rename();
                if (event.key === "Escape") setNaming(undefined);
              }}
              className="block h-5 w-full bg-transparent p-0 text-[15px] leading-5 font-semibold outline-none"
            />
          )}
          <div className="truncate text-[13px] leading-[18px] text-muted-foreground">
            {agent.name}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Chat options">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            // Closed, the menu gives the keyboard back to its button, unless Rename takes it.
            onCloseAutoFocus={(event) => {
              if (renaming.current) event.preventDefault();
              renaming.current = false;
            }}
          >
            {/* After the menu has closed and let go of the keyboard. */}
            <DropdownMenuItem
              onSelect={() => {
                renaming.current = true;
                setTimeout(() => setNaming(entry.title), 0);
              }}
            >
              Rename
            </DropdownMenuItem>
            {!off && (
              <DropdownMenuItem
                onSelect={() => {
                  leaving.current = !entry.archived;
                  change("archive", { archived: !entry.archived });
                }}
              >
                {entry.archived ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <CloseChats />
      </header>
      <MessageScrollerProvider defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="no-bar">
            <MessageScrollerContent className="mx-auto w-full max-w-[720px] gap-6 px-4 pt-3 pb-4">
              {hasEarlier && (
                <MessageScrollerItem>
                  <Marker variant="separator" className="justify-center text-xs">
                    <MarkerContent>
                      <Button variant="ghost" size="xs" onClick={() => void earlier()}>
                        Earlier messages
                      </Button>
                    </MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              )}
              {turns.map((turn) => (
                <MessageScrollerItem
                  key={turn.id}
                  scrollAnchor={turn.kind === "user"}
                  className="[content-visibility:visible]"
                >
                  {turn.kind === "user" ? (
                    <Message align="end">
                      <MessageContent className="gap-1">
                        <Bubble variant="secondary" align="end">
                          <BubbleContent className="rounded-3xl px-4 py-2 text-[15px] whitespace-pre-wrap">
                            {turn.text}
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  ) : (
                    <Reply
                      parts={turn.parts}
                      rows={rows}
                      reduced={reduced}
                      isLast={turn === lastTurn}
                      awaiting={awaiting}
                      thinking={thinking && turn === lastTurn}
                    />
                  )}
                </MessageScrollerItem>
              ))}
              {/* Under the person's message; once the agent has done something, under that. */}
              {thinking && lastTurn?.kind !== "agent" && (
                <MessageScrollerItem>
                  <Thinking />
                </MessageScrollerItem>
              )}
              {wrong && <ProblemLine fix={fix}>{wrong}</ProblemLine>}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {!off && (
        <div className="mx-auto w-full max-w-[720px] shrink-0 px-3 pb-3">
          <Composer name={agent.name} draft={`${agent.id} ${id}`} onSend={send} />
        </div>
      )}
    </div>
  );
}

/** The agent is at work on a reply, and nothing of it is arriving just now. */
const Thinking = () => (
  <div role="status" className="thinking w-fit text-[15px] font-medium">
    Thinking
  </div>
);

/**
 * A call's row; a poll has none of its own, it's part of the command's. Something the agent did
 * that carries no call is its one line, as a call's line without what a call has to open.
 */
function Tool({ message, row }: { message: ChatMessage; row?: Row | undefined }) {
  if (!message.tool)
    return (
      <p
        data-call
        className="flex h-7 items-center gap-2 px-1 text-[13px] text-muted-foreground [[data-call]+&]:-mt-1.5"
      >
        <WrenchIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{message.text}</span>
      </p>
    );
  return row && row.kind !== "say" ? <CallRow row={row} /> : null;
}

function Reply({
  parts,
  rows,
  reduced,
  isLast,
  awaiting,
  thinking,
}: {
  parts: Part[];
  rows: ReadonlyMap<string, Row>;
  reduced: boolean;
  isLast: boolean;
  /** The chat still awaits its reply: the last one isn't settled, and offers nothing yet. */
  awaiting: boolean;
  /** Nothing of it is arriving just now. */
  thinking: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const texts = parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
  const settled = !(isLast && (awaiting || parts.some((p) => p.kind === "text" && p.streaming)));
  return (
    <Message className="group/reply">
      <MessageContent className="gap-2">
        {parts.map((part) =>
          part.kind === "tool" ? (
            <Tool key={part.message.id} message={part.message} row={rows.get(part.message.id)} />
          ) : (
            <Bubble key={part.id} variant="ghost" className="w-full">
              {/* Its size is said here: the bubble's own would outrank a rule of the sheet's. */}
              <BubbleContent className="prose-chat w-full text-[15px] leading-[1.6]">
                <Streamdown
                  controls={{ table: false, code: true }}
                  animated={{
                    animation: "reveal",
                    duration: 260,
                    easing: "ease-out",
                    stagger: 14,
                    maxBacklogMs: 420,
                  }}
                  isAnimating={!!part.streaming && !reduced}
                >
                  {part.text}
                </Streamdown>
              </BubbleContent>
            </Bubble>
          ),
        )}
        {thinking && <Thinking />}
        {/* Its room is always kept, so nothing moves when it appears. */}
        <MessageFooter
          className={`h-6 gap-0.5 px-0 ${!settled ? "invisible" : isLast ? "" : "invisible group-hover/reply:visible"}`}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy"
            onClick={() => {
              void navigator.clipboard.writeText(texts.join("\n\n"));
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

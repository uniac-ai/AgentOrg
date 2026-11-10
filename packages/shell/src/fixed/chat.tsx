// One agent's chat, over its `chat@1`. The record and the status come from the chat; the page keeps
// only what it shows.
import { NotConnected, Refused } from "@agentorg/sdk";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SquareIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import { USAGE } from "../app.tsx";
import { api, go, useConnection } from "../data.ts";
import { signIn } from "../sign-in.ts";
import { Bubble, BubbleContent } from "../ui/bubble.tsx";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
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
import { CallRow } from "./call-row.tsx";
import { type Row, rowsOf } from "./calls.ts";
import { DOCKED, useChats } from "./chats.tsx";
import { ago, type ChatMessage, type ChatStatus, chatView, useAct } from "./data.ts";
import { type Notice, noticeOf } from "./notice.ts";
import { Nothing, SidePanel, StateDot } from "./parts.tsx";
import { useAgents } from "./watch.tsx";

const PAGE = 100;
const busyOf = (state: string) => state === "thinking" || state === "tool";

const codeOf = (error: unknown) => ({
  code:
    error instanceof Refused
      ? error.code
      : error instanceof NotConnected
        ? "not_connected"
        : "failed",
  message: error instanceof Error ? error.message : "That didn't work.",
});

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

/** The chats, one session per agent, in the panel the top bar opens. */
export function ChatPanel() {
  const { open, thread } = useChats();
  if (!open) return null;
  return (
    <SidePanel label="Chats">
      {thread ? <Thread key={thread} agent={thread} /> : <List />}
    </SidePanel>
  );
}

function List() {
  const { sessions, show } = useChats();
  return (
    <>
      <h2 className="flex h-11 shrink-0 items-center px-4 text-[13px] font-semibold">Chats</h2>
      <ul className="no-bar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.map((session) => (
          <li key={session.agent}>
            <button
              type="button"
              onClick={() => show(session.agent)}
              className="flex h-16 w-full items-center gap-2 rounded-xl px-2 text-left hover:bg-[var(--hover)]"
            >
              {session.fresh ? (
                <span
                  role="img"
                  aria-label="New"
                  className="size-2 shrink-0 rounded-full bg-[var(--unread)]"
                />
              ) : (
                <span className="size-2 shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-sm ${session.fresh ? "font-semibold" : "font-medium"}`}
                >
                  {session.name}
                </span>
                {session.working ? (
                  <span className="thinking block w-fit text-[13px]">Working</span>
                ) : (
                  <span className="block truncate text-[13px] text-muted-foreground">
                    {session.preview}
                  </span>
                )}
              </span>
              <span className="shrink-0 self-start pt-3 text-xs tabular-nums text-muted-foreground">
                {ago(session.at)}
              </span>
            </button>
          </li>
        ))}
        {sessions.length === 0 && (
          <li className="px-2">
            <Nothing>Start one with Chat on an agent.</Nothing>
          </li>
        )}
      </ul>
    </>
  );
}

function Thread({ agent: id }: { agent: string }) {
  const { show, close, drop, drafts } = useChats();
  const { byId } = useAgents();
  const shell = useRef<HTMLDivElement>(null);
  const act = useAct();
  const watched = byId.get(id);
  if (!watched) return null;
  const { entry, slot, now } = watched;
  return (
    <div ref={shell} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1.5 px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="All chats"
          onClick={() => show(undefined)}
        >
          <ChevronLeftIcon />
        </Button>
        <StateDot tone={now.tone} />
        <Button
          variant="link"
          className="h-auto min-w-0 truncate border-0 p-0 text-[13px] font-semibold text-foreground"
          onClick={() => {
            go({ screen: "agent", agent: id });
            // Over the page, the panel gets out of its way; docked, it stays beside it.
            const width = shell.current?.closest("[data-shell]")?.clientWidth ?? 0;
            if (width < DOCKED) close();
          }}
        >
          {entry.name}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label={`${entry.name} chat options`}
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => drop(id)}>Remove from Chats</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {entry.status.state !== "running" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm">
            {entry.status.state === "starting"
              ? "Starting…"
              : entry.status.state === "stopped"
                ? `${entry.name} is stopped.`
                : (entry.status.detail ?? `${entry.name} is down.`)}
          </p>
          {entry.status.state === "stopped" && (
            <Button
              size="sm"
              disabled={act.busy}
              onClick={() => act.run(() => api.call("agents", "start", { agent: id }))}
            >
              Start
            </Button>
          )}
          {act.failed && (
            <p role="alert" className="text-[13px] text-[var(--bad)]">
              {act.failed}
            </p>
          )}
        </div>
      ) : (
        slot && <Chat slot={slot} name={entry.name} drafts={drafts} agent={id} />
      )}
    </div>
  );
}

function Chat({
  slot,
  name,
  agent,
  drafts,
}: {
  slot: string;
  name: string;
  agent: string;
  drafts: Map<string, string>;
}) {
  const connection = useConnection();
  const reduced = useReducedMotion();
  /** The record, in order, and the text still streaming by id. */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  /** What the person sent, shown at once, until the record has it. */
  const [sending, setSending] = useState<readonly Sending[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  // What's half typed waits for the person, in this session.
  const [text, setTextState] = useState(drafts.get(agent) ?? "");
  const setText = (value: string) => {
    drafts.set(agent, value);
    setTextState(value);
  };
  // What the async reads below merge into: always the latest.
  const shown = useRef(messages);
  shown.current = messages;
  /** Which of the agent's chats this is: its newest, or the one the first message here starts. */
  const view = useMemo(() => chatView(slot), [slot]);
  const sends = useRef(0);
  /** A recorded message's key in the thread: the one it was shown under at once, so it stays. */
  const keys = useRef(new Map<string, string>());

  const failed = (error: unknown) =>
    setNotice({ ...noticeOf(codeOf(error)), untilRead: error instanceof NotConnected });

  useEffect(() => {
    if (connection !== "open") return;
    let live = true;
    /**
     * The record and the status now. The record outranks what streamed, and only what arrives
     * while the page is read is newer than it.
     */
    const load = async () => {
      const since = shown.current.length;
      try {
        const of = await view.find();
        // No chat yet: nothing was said, and the first message starts one.
        const [{ messages: page, more }, now]: [
          { messages: ChatMessage[]; more: boolean },
          ChatStatus,
        ] = of
          ? await Promise.all([
              api.call<{ messages: ChatMessage[]; more: boolean }>(slot, "history", {
                chat: of,
                limit: PAGE,
              }),
              api.call<ChatStatus>(slot, "state", { chat: of }),
            ])
          : [{ messages: [], more: false }, { state: "idle" }];
        if (!live) return;
        const known = new Set(page.map((m) => m.id));
        setMessages([...page, ...shown.current.slice(since).filter((m) => !known.has(m.id))]);
        setHasEarlier(more);
        setBusy(busyOf(now.state));
        setNotice((was) =>
          now.state === "error" && now.detail
            ? noticeOf(now.detail)
            : was?.untilRead
              ? undefined
              : was,
        );
      } catch (error) {
        if (live && !(error instanceof NotConnected))
          setNotice({ ...noticeOf(codeOf(error)), untilRead: true });
      }
    };
    const stops = [
      api.subscribe(
        slot,
        "message",
        (payload) => {
          if (!view.hears(payload)) return;
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
          if (!view.hears(payload)) return;
          const { id, text: piece } = payload as { id: string; text: string };
          // A late piece of a reply already settled changes nothing.
          if (shown.current.some((m) => m.id === id)) return;
          setStreaming((was) => new Map(was).set(id, (was.get(id) ?? "") + piece));
        },
        { again: load },
      ),
      api.subscribe(
        slot,
        "status",
        (payload) => {
          if (!view.hears(payload)) return;
          const status = payload as ChatStatus;
          setBusy(busyOf(status.state));
          if (status.state === "thinking") setNotice(undefined);
          // A reply cut off by a cancel or an error never settles: it goes.
          if (status.state === "idle" || status.state === "error") setStreaming(new Map());
          if (status.state === "error" && status.detail) setNotice(noticeOf(status.detail));
        },
        { again: load },
      ),
    ];
    void load();
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, [slot, view, connection]);

  const recorded = new Set(messages.map((m) => m.id));
  const unrecorded = sending.filter((m) => !m.messageId || !recorded.has(m.messageId));
  // Until the record has what was sent: "Thinking" never drops out between the two.
  const running = busy || unrecorded.length > 0;
  const rows = useMemo(() => new Map(rowsOf(messages).map((row) => [row.id, row])), [messages]);
  const turns = useMemo(
    () => turnsOf(messages, unrecorded, streaming, keys.current),
    [messages, unrecorded, streaming],
  );
  const lastTurn = turns.at(-1);
  const toolRunning = messages.at(-1)?.tool?.state === "running";
  const thinking = running && streaming.size === 0 && !toolRunning;

  const send = async () => {
    const body = text.trim();
    if (!body || running) return;
    setNotice(undefined);
    setText("");
    const id = `sending-${++sends.current}`;
    setSending((was) => [...was, { id, text: body }]);
    try {
      // In the chat shown, once it's known which that is. With none, this starts one.
      const of = await view.find();
      const sent = await api.call<{ chat: string; messageId: string }>(slot, "send", {
        ...(of ? { chat: of } : {}),
        text: body,
      });
      view.started(sent.chat);
      const { messageId } = sent;
      keys.current.set(messageId, id);
      setSending((was) => was.map((m) => (m.id === id ? { ...m, messageId } : m)));
    } catch (error) {
      setSending((was) => was.filter((m) => m.id !== id));
      setText(body);
      failed(error);
    }
  };
  /** Runs the last turn again; the new reply takes the place of what followed the message. */
  const retry = () => {
    const of = view.chat;
    if (!of) return;
    setNotice(undefined);
    const before = shown.current;
    setMessages(before.slice(0, before.findLastIndex((m) => m.role === "user") + 1));
    setStreaming(new Map());
    api.call(slot, "retry", { chat: of }).catch((error) => {
      setMessages(before);
      failed(error);
    });
  };
  /** Stops the turn. A first message still on its way has no chat to stop yet. */
  const stop = async () => {
    const of = view.chat;
    if (of) await api.call(slot, "cancel", { chat: of }).catch(failed);
  };
  const earlier = async () => {
    const oldest = shown.current[0];
    const of = view.chat;
    if (!oldest || !of) return;
    try {
      const { messages: page, more } = await api.call<{
        messages: ChatMessage[];
        more: boolean;
      }>(slot, "history", { chat: of, before: oldest.id, limit: PAGE });
      setMessages((was) => {
        const known = new Set(was.map((m) => m.id));
        return [...page.filter((m) => !known.has(m.id)), ...was];
      });
      setHasEarlier(more);
    } catch (error) {
      failed(error);
    }
  };
  const runNotice = (action: NonNullable<Notice["action"]>["run"]) => {
    if (action === "manage") window.open(USAGE, "_blank", "noopener,noreferrer");
    else if (action === "signIn") void signIn().catch(failed);
    else retry();
  };
  const action = notice?.action;
  const offered = action && (action.run !== "retry" || messages.some((m) => m.role === "user"));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageScrollerProvider defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="no-bar">
            <MessageScrollerContent className="w-full gap-6 px-4 pt-3 pb-4">
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
                      <MessageContent>
                        <Bubble variant="secondary" align="end">
                          <BubbleContent className="rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap">
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
                      running={running}
                      onRetry={retry}
                    />
                  )}
                </MessageScrollerItem>
              ))}
              {thinking && (
                <MessageScrollerItem>
                  <div role="status" className="thinking w-fit text-sm font-medium">
                    Thinking
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="shrink-0 px-2.5 pb-2.5">
        {notice && (
          <div
            role="alert"
            className="mb-2 flex flex-col gap-1.5 rounded-xl bg-card p-3 text-[13px]"
          >
            {notice.title && <b className="font-semibold">{notice.title}</b>}
            <span>{notice.text}</span>
            {offered && (
              <div>
                <Button size="sm" onClick={() => runNotice(action.run)}>
                  {action.label}
                </Button>
              </div>
            )}
          </div>
        )}
        <InputGroup className="rounded-2xl bg-[var(--raised)]">
          <InputGroupTextarea
            aria-label="Message"
            placeholder={`Message ${name}`}
            className="min-h-11 text-sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <InputGroupAddon align="block-end" className="gap-1 text-xs text-muted-foreground">
            <span className="truncate pl-1.5">Using ChatGPT plan</span>
            <a
              href={USAGE}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Manage usage
            </a>
            <InputGroupButton
              size="icon-sm"
              variant="default"
              className="ml-auto rounded-full"
              aria-label={running ? "Stop" : "Send"}
              disabled={!running && !text.trim()}
              onClick={() => void (running ? stop() : send())}
            >
              {running ? <SquareIcon className="fill-current" /> : <ArrowUpIcon />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}

/** A call's row; a poll has none of its own, it's part of the command's. */
function Tool({ message, row }: { message: ChatMessage; row?: Row | undefined }) {
  if (!message.tool)
    return (
      <p className="flex h-8 items-center gap-2 px-1 text-[13px] text-muted-foreground">
        <WrenchIcon className="size-3.5" />
        {message.text}
      </p>
    );
  return row && row.kind !== "say" ? <CallRow row={row} /> : null;
}

function Reply({
  parts,
  rows,
  reduced,
  isLast,
  running,
  onRetry,
}: {
  parts: Part[];
  rows: ReadonlyMap<string, Row>;
  reduced: boolean;
  isLast: boolean;
  running: boolean;
  onRetry(): void;
}) {
  const [copied, setCopied] = useState(false);
  const texts = parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
  const settled = !(isLast && running);
  return (
    <Message className="group/reply">
      <MessageContent className="gap-3">
        {parts.map((part) =>
          part.kind === "tool" ? (
            <Tool key={part.message.id} message={part.message} row={rows.get(part.message.id)} />
          ) : (
            <Bubble key={part.id} variant="ghost" className="w-full">
              <BubbleContent className="prose-chat w-full">
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
        {/* Their room is always kept, so nothing moves when they appear. */}
        <MessageFooter
          className={`h-7 gap-0.5 px-0 ${!settled ? "invisible" : isLast ? "" : "invisible group-hover/reply:visible"}`}
        >
          {texts.length > 0 && (
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
          )}
          {isLast && (
            <Button variant="ghost" size="icon-xs" aria-label="Retry" onClick={onRetry}>
              <RefreshCwIcon />
            </Button>
          )}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

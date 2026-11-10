// One agent's chat, over its `chat@1`. The record is the chat's and whether it works is the
// agent's; the page keeps only what it shows.
import { NotConnected, Refused } from "@agentorg/sdk";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  LoaderCircleIcon,
  WrenchIcon,
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
import { useAllChats } from "./all-chats.tsx";
import { CallRow } from "./call-row.tsx";
import { type Row, rowsOf } from "./calls.ts";
import { useChats } from "./chats.tsx";
import { type ChatMessage, type ChatStatus, chatView, useAct } from "./data.ts";
import { type Notice, noticeOf } from "./notice.ts";
import { StateDot } from "./parts.tsx";
import { useAgents } from "./watch.tsx";

const PAGE = 100;

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

/** One agent's thread, with the control that closes what it is shown in at the end of its head. */
export function Thread({ agent: id, close }: { agent: string; close: React.ReactNode }) {
  const { show, drafts } = useChats();
  const { byId } = useAgents();
  const act = useAct();
  const watched = byId.get(id);
  if (!watched) return null;
  const { entry, slot, now } = watched;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
          onClick={() => go({ screen: "agent", agent: id })}
        >
          {entry.name}
        </Button>
        <span className="ml-auto">{close}</span>
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
  /** Whether the agent works, in this chat or another. */
  const [working, setWorking] = useState(false);
  /** A call of this page's that failed. */
  const [failure, setFailure] = useState<Notice>();
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
  // A reply shown here is read; and the chat's problem is its entry's, until its next reply.
  const { read, chats } = useAllChats();
  const problem = chats.find((one) => one.agent.id === agent && one.entry.id === view.chat)?.entry
    .problem;
  // A reply cut off by a problem never settles: it goes.
  const failed = !!problem;
  useEffect(() => {
    if (failed) setStreaming(new Map());
  }, [failed]);
  const replied = messages.findLast((m) => m.role === "assistant")?.at;
  useEffect(() => {
    if (view.chat && replied) read(agent, view.chat, replied);
  }, [read, agent, view, replied]);
  const sends = useRef(0);
  /** A recorded message's key in the thread: the one it was shown under at once, so it stays. */
  const keys = useRef(new Map<string, string>());

  const refused = (error: unknown) =>
    setFailure({ ...noticeOf(codeOf(error)), untilRead: error instanceof NotConnected });

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
        // The status is the agent's. With no chat yet nothing was said, and the first message
        // starts one.
        const [{ messages: page, more }, now] = await Promise.all([
          of
            ? api.call<{ messages: ChatMessage[]; more: boolean }>(slot, "history", {
                chat: of,
                limit: PAGE,
              })
            : { messages: [], more: false },
          api.call<ChatStatus>(slot, "state", {}),
        ]);
        if (!live) return;
        const known = new Set(page.map((m) => m.id));
        setMessages([...page, ...shown.current.slice(since).filter((m) => !known.has(m.id))]);
        setHasEarlier(more);
        setWorking(now.state === "working");
        setFailure((was) => (was?.untilRead ? undefined : was));
      } catch (error) {
        if (live && !(error instanceof NotConnected))
          setFailure({ ...noticeOf(codeOf(error)), untilRead: true });
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
          const status = payload as ChatStatus;
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
  }, [slot, view, connection]);

  const recorded = new Set(messages.map((m) => m.id));
  const unrecorded = sending.filter((m) => !m.messageId || !recorded.has(m.messageId));
  // A chat is messages only: it awaits a reply while the newest thing said in it is the person's
  // and the agent works. Until the record has what was sent, "Thinking" never drops out between
  // the two.
  const asked = messages.findLast((m) => m.role !== "tool")?.role === "user";
  const awaiting = unrecorded.length > 0 || (working && asked);
  // While it awaits a reply its problem is not said: the reply ends it, or it is said again.
  const notice = failure ?? (problem && !awaiting ? noticeOf(problem) : undefined);
  const rows = useMemo(() => new Map(rowsOf(messages).map((row) => [row.id, row])), [messages]);
  const turns = useMemo(
    () => turnsOf(messages, unrecorded, streaming, keys.current),
    [messages, unrecorded, streaming],
  );
  const lastTurn = turns.at(-1);
  const toolRunning = messages.at(-1)?.tool?.state === "running";
  const thinking = awaiting && streaming.size === 0 && !toolRunning;

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setFailure(undefined);
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
      refused(error);
    }
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
      refused(error);
    }
  };
  const runNotice = (action: NonNullable<Notice["action"]>["run"]) => {
    if (action === "manage") window.open(USAGE, "_blank", "noopener,noreferrer");
    else void signIn().catch(refused);
  };
  const action = notice?.action;

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
                      awaiting={awaiting}
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
            {action && (
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
              aria-label="Send"
              disabled={!text.trim()}
              onClick={() => void send()}
            >
              <ArrowUpIcon />
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
  awaiting,
}: {
  parts: Part[];
  rows: ReadonlyMap<string, Row>;
  reduced: boolean;
  isLast: boolean;
  awaiting: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const texts = parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
  const settled = !(isLast && awaiting);
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
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

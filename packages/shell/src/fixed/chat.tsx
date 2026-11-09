// One agent's chat, over its `chat@1`. The record and the status come from the chat; the page keeps
// only what it shows.
import { NotConnected, Refused } from "@agentorg/sdk";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SquareIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import { USAGE } from "../app.tsx";
import { api, useConnection, useLoad } from "../data.ts";
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
import { type ChatMessage, type ChatStatus, getAgent, useAct, useChatSlots } from "./data.ts";

const PAGE = 100;
const busyOf = (state: string) => state === "thinking" || state === "tool";

interface Notice {
  title?: string;
  text: string;
  action?: { label: string; run: "manage" | "signIn" | "retry" };
  /** A failed read, or the chat not being there: a good read ends it. */
  untilRead?: boolean;
}

/** What a turn ending in error shows, in OpenAI's words for plan usage. */
function noticeOf(detail: { code: string; message: string }): Notice {
  switch (detail.code) {
    case "usage_limit":
      return {
        title: "Usage limit reached",
        text: "Review your plan or this app's limit in ChatGPT settings.",
        action: { label: "Manage usage", run: "manage" },
      };
    case "not_signed_in":
      return {
        text: "Sign in with ChatGPT to chat on your plan.",
        action: { label: "Continue with ChatGPT", run: "signIn" },
      };
    case "unavailable":
      return {
        text: "ChatGPT plan usage is unavailable right now.",
        action: { label: "Retry", run: "retry" },
      };
    case "ineligible":
      return { text: "This ChatGPT account isn't eligible to use its plan in this app." };
    default:
      return { text: detail.message };
  }
}

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

export function ChatPage({ agent: id }: { agent: string }) {
  const detail = useLoad(() => getAgent(id), ["actors"], [id]);
  const slot = useChatSlots().get(id);
  const agent = detail.value;
  const act = useAct();
  return (
    <>
      {agent && agent.status.state !== "running" ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-[15px]">
            {agent.status.state === "starting"
              ? "Starting…"
              : agent.status.state === "stopped"
                ? `${agent.name} is stopped.`
                : (agent.status.detail ?? `${agent.name} is down.`)}
          </p>
          {agent.status.state === "stopped" && (
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
        agent && slot && <Chat slot={slot} name={agent.name} />
      )}
    </>
  );
}

function Chat({ slot, name }: { slot: string; name: string }) {
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
  const [text, setText] = useState("");
  // What the async reads below merge into: always the latest.
  const shown = useRef(messages);
  shown.current = messages;
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
    const load = () => {
      const since = shown.current.length;
      Promise.all([
        api.call<{ messages: ChatMessage[]; more: boolean }>(slot, "history", { limit: PAGE }),
        api.call<ChatStatus>(slot, "state"),
      ]).then(
        ([{ messages: page, more }, now]) => {
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
        },
        (error) => {
          if (live && !(error instanceof NotConnected))
            setNotice({ ...noticeOf(codeOf(error)), untilRead: true });
        },
      );
    };
    const stops = [
      api.subscribe(
        slot,
        "message",
        (payload) => {
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
          setBusy(busyOf(status.state));
          if (status.state === "thinking") setNotice(undefined);
          // A reply cut off by a cancel or an error never settles: it goes.
          if (status.state === "idle" || status.state === "error") setStreaming(new Map());
          if (status.state === "error" && status.detail) setNotice(noticeOf(status.detail));
        },
        { again: load },
      ),
    ];
    load();
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, [slot, connection]);

  const recorded = new Set(messages.map((m) => m.id));
  const unrecorded = sending.filter((m) => !m.messageId || !recorded.has(m.messageId));
  // Until the record has what was sent: "Thinking" never drops out between the two.
  const running = busy || unrecorded.length > 0;
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
      const { messageId } = await api.call<{ messageId: string }>(slot, "send", { text: body });
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
    setNotice(undefined);
    const before = shown.current;
    setMessages(before.slice(0, before.findLastIndex((m) => m.role === "user") + 1));
    setStreaming(new Map());
    api.call(slot, "retry").catch((error) => {
      setMessages(before);
      failed(error);
    });
  };
  const earlier = async () => {
    const oldest = shown.current[0];
    if (!oldest) return;
    try {
      const { messages: page, more } = await api.call<{
        messages: ChatMessage[];
        more: boolean;
      }>(slot, "history", { before: oldest.id, limit: PAGE });
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
    <div className="@container flex h-full flex-col">
      <MessageScrollerProvider defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="no-bar">
            <MessageScrollerContent className="mx-auto w-full max-w-[44rem] gap-8 px-5 pt-8 pb-6 @max-[460px]:px-3.5 @max-[460px]:pt-5">
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
                          <BubbleContent className="rounded-2xl px-3.5 py-2 text-[15px] whitespace-pre-wrap">
                            {turn.text}
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  ) : (
                    <Reply
                      parts={turn.parts}
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
                  <div role="status" className="thinking w-fit text-[15px] font-medium">
                    Thinking
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="mx-auto w-full max-w-[44rem] shrink-0 px-5 pb-4 @max-[460px]:px-2.5 @max-[460px]:pb-2.5">
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
            className="min-h-11 text-[15px]"
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
              onClick={() => (running ? void api.call(slot, "cancel").catch(failed) : void send())}
            >
              {running ? <SquareIcon className="fill-current" /> : <ArrowUpIcon />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}

function Reply({
  parts,
  reduced,
  isLast,
  running,
  onRetry,
}: {
  parts: Part[];
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
            <ToolCall key={part.message.id} message={part.message} />
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

/** A tool call as one quiet row, opened for what went in and came back. */
function ToolCall({ message }: { message: ChatMessage }) {
  const tool = message.tool;
  if (!tool)
    return (
      <p className="flex h-8 items-center gap-2 px-1 text-[13px] text-muted-foreground">
        <WrenchIcon className="size-3.5" />
        {message.text}
      </p>
    );
  const body = [tool.input, tool.output && `→ ${tool.output}`].filter(Boolean).join("\n");
  return (
    <Collapsible className="group/tool rounded-lg text-[13px]">
      <CollapsibleTrigger className="flex h-8 w-full items-center gap-2 rounded-lg px-1 text-left text-muted-foreground hover:bg-[var(--hover)] hover:text-foreground">
        {tool.state === "running" ? (
          <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <WrenchIcon className="size-3.5" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{tool.name}</span>
        {tool.state === "done" && (
          <CheckIcon className="size-3.5 text-[var(--ok)]" aria-label="done" />
        )}
        {tool.state === "refused" && (
          <XIcon className="size-3.5 text-[var(--bad)]" aria-label="refused" />
        )}
        <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/tool:rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      {body && (
        <CollapsibleContent>
          <pre className="mt-1 mb-1 ml-6 rounded-lg bg-[var(--raised)] px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {body}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

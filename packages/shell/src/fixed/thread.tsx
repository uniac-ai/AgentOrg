// One chat, over its agent's `chat@1`: a title, one agent, its messages; and a chat about to be
// started. The record is the chat's and whether it works is the agent's. A chat has no Stop and
// no model to choose: its work is stopped by saying so in it, and the model is the agent's, in
// its setup.
import { PICTURES_MAX } from "@agentorg/interfaces";
import { NotConnected } from "@agentorg/sdk";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  CopyIcon,
  ImagePlusIcon,
  MonitorIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import { api, go, useConnection } from "../data.ts";
import { Bubble, BubbleContent } from "../ui/bubble.tsx";
import { Button } from "../ui/button.tsx";
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
  useMessageScroller,
  useMessageScrollerScrollable,
} from "../ui/message-scroller.tsx";
import { type ListedChat, PERSON, useAllChats } from "./all-chats.tsx";
import { CloseChats } from "./chat-parts.tsx";
import { useChats } from "./chats.tsx";
import { surfacesOf, windowsOf } from "./computer.tsx";
import { useComputers } from "./computers.tsx";
import { type ChatMessage, type ChatStatus, reasonOf, type Tone } from "./data.ts";
import { Face } from "./face.tsx";
import { needsOf, SignInButton, useLogin } from "./login.tsx";
import { fixOf } from "./notice.ts";
import { fit, type Put, type Sent, sourceOf, together } from "./pictures.ts";
import { useAgents } from "./watch.tsx";

const PAGE = 100;

/** The pictures put in a box and not yet sent, and how many puts are still being fitted. */
interface Box {
  pictures: readonly Put[];
  fitting: number;
}
const EMPTY: Box = { pictures: [], fitting: 0 };
/** Each box's pictures, kept as what is typed there is: by whose draft it is. */
const boxes = new Map<string, Box>();
const boxWatchers = new Set<() => void>();
const boxOf = (draft: string) => boxes.get(draft) ?? EMPTY;
function changeBox(draft: string, change: (was: Box) => Box) {
  boxes.set(draft, change(boxOf(draft)));
  for (const watcher of boxWatchers) watcher();
}
const watchBoxes = (watcher: () => void) => {
  boxWatchers.add(watcher);
  return () => {
    boxWatchers.delete(watcher);
  };
};

/** A message the person sent that the record doesn't have yet; `messageId` once `send` says it. */
interface Sending {
  id: string;
  text: string;
  images: Sent[];
  messageId?: string;
}

/** What the thread shows: each message of the person, then what the agent said. */
type Turn =
  | { kind: "user"; id: string; text: string; images: readonly Sent[] }
  | { kind: "agent"; id: string; parts: Part[] };
type Part = { id: string; text: string; streaming?: boolean };

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
      turns.push({
        kind: "user",
        id: keys.get(message.id) ?? message.id,
        text: message.text,
        images: message.images ?? [],
      });
    else agentTurn(message.id).parts.push({ id: message.id, text: message.text });
  }
  for (const { id, text, images } of unrecorded) turns.push({ kind: "user", id, text, images });
  for (const [id, text] of streaming) agentTurn(id).parts.push({ id, text, streaming: true });
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
  /** Sends it; false when it wasn't taken, and the text and pictures stay. */
  onSend(text: string, images: Sent[]): Promise<boolean>;
}) {
  const { drafts } = useChats();
  const needs = needsOf(useLogin());
  const [text, setTextState] = useState(drafts.get(draft) ?? "");
  // Pictures to send with it, pasted into the box or picked with its button, kept as its text is.
  const box = useSyncExternalStore(watchBoxes, () => boxOf(draft));
  const picker = useRef<HTMLInputElement>(null);
  const words = useRef<HTMLTextAreaElement>(null);
  const setText = (value: string) => {
    drafts.set(draft, value);
    setTextState(value);
  };
  /** Puts the pictures among these files in the box they were put in, once fitted; whether any was. */
  const attach = (files: Iterable<File>) => {
    const pictures = [...files].filter((file) => file.type.startsWith("image/"));
    if (pictures.length === 0) return false;
    changeBox(draft, (was) => ({ ...was, fitting: was.fitting + 1 }));
    void Promise.all(
      pictures.map(async (file): Promise<Put[]> => {
        const picture = await fit(file).catch(() => undefined);
        return picture ? [{ file, picture }] : [];
      }),
    ).then((fitted) =>
      changeBox(draft, (was) => ({
        pictures: [...was.pictures, ...fitted.flat()].slice(0, PICTURES_MAX),
        fitting: was.fitting - 1,
      })),
    );
    return true;
  };
  // A message is words, pictures or both; nothing goes while a picture is being fitted.
  const ready = (!!text.trim() || box.pictures.length > 0) && box.fitting === 0;
  const submit = async () => {
    const body = text.trim();
    if (!ready) return;
    const put = box.pictures;
    setText("");
    changeBox(draft, () => EMPTY);
    const sent = await onSend(body, await together(put));
    // Not taken, it is back in the box unless something else was put there meanwhile.
    if (!sent && !drafts.get(draft) && boxOf(draft) === EMPTY) {
      setText(body);
      changeBox(draft, (was) => ({ ...was, pictures: put }));
    }
  };
  // Signed out of the model account, nothing can be sent: its place says why and holds the way in.
  if (needs)
    return (
      // biome-ignore lint/a11y/useSemanticElements: one place with its name, not a set of fields.
      <div
        role="group"
        aria-label="Sign in to send"
        className="flex min-h-[108px] flex-col justify-center gap-2.5 rounded-3xl bg-[var(--raised)] px-4 py-3.5"
      >
        <span className="px-1 text-[15px] leading-5">{needs}</span>
        <SignInButton className="w-full" />
      </div>
    );
  return (
    <InputGroup className="rounded-3xl border-0 bg-[var(--raised)] shadow-none">
      {/* What is to be sent with the words, above them. Each can be taken out again, by a mark shown when it is pointed at. */}
      {box.pictures.length > 0 && (
        <InputGroupAddon align="block-start" className="flex-wrap gap-2 px-3 pt-3">
          {box.pictures.map(({ picture }, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same picture may be put in twice.
            <span key={n} className="group/picture relative size-16 shrink-0">
              <span className="window relative block size-16 overflow-hidden rounded-xl">
                <img
                  src={sourceOf(picture)}
                  // biome-ignore lint/a11y/noRedundantAlt: each is named by its place, as the person counts them.
                  alt={`Picture ${n + 1}`}
                  className="size-16 object-cover"
                />
              </span>
              <Button
                variant="secondary"
                size="icon-xs"
                aria-label={`Remove picture ${n + 1}`}
                className="absolute -top-1.5 -right-1.5 rounded-full opacity-0 shadow group-hover/picture:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                onClick={() => {
                  changeBox(draft, (was) => ({
                    ...was,
                    pictures: was.pictures.filter((_, i) => i !== n),
                  }));
                  // Its mark goes with it, and the person is back at the words.
                  words.current?.focus();
                }}
              >
                <XIcon />
              </Button>
            </span>
          ))}
        </InputGroupAddon>
      )}
      <InputGroupTextarea
        ref={words}
        aria-label="Message"
        placeholder={`Message ${name}`}
        className="min-h-14 px-4 pt-3.5 text-[15px]"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          // Words copied with a picture of them, as from a sheet or a document, go in as words.
          if (/\S/.test(event.clipboardData.getData("text/plain"))) return;
          if (attach(event.clipboardData.files)) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <InputGroupAddon align="block-end" className="gap-1 px-2.5 pb-2.5">
        {/* The way to pick a picture, for one that isn't pasted. */}
        <InputGroupButton
          size="icon-sm"
          variant="ghost"
          className="shrink-0 rounded-full"
          aria-label="Attach a picture"
          onClick={() => picker.current?.click()}
        >
          <ImagePlusIcon />
        </InputGroupButton>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Pictures to attach"
          onChange={(event) => {
            attach(event.target.files ?? []);
            event.target.value = "";
          }}
        />
        <InputGroupButton
          size="icon-sm"
          variant="default"
          className="ml-auto shrink-0 rounded-full"
          aria-label="Send"
          disabled={!ready}
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

/**
 * The head of your conversation with an agent: back to the list, its face to its page, its name;
 * and, once it has begun, its computer. One between two agents is named by both, and says it is
 * there to be read.
 */
function Head({
  agent,
  other,
  begun,
  children,
}: {
  agent: { id: string; name: string; tone: Tone };
  other?: { name: string } | undefined;
  begun: boolean;
  children?: React.ReactNode;
}) {
  const { show, close } = useChats();
  return (
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
      {/* One not begun is headed by the agent alone, as the design draws it. */}
      {begun ? (
        <div className="ml-1.5 min-w-0 flex-1">
          <h2 className="truncate text-[15px] leading-5 font-semibold">
            {other ? `${agent.name} and ${other.name}` : agent.name}
          </h2>
          {other && (
            <div className="truncate text-[13px] leading-[18px] text-muted-foreground">
              You can read it, not write in it
            </div>
          )}
        </div>
      ) : (
        <h2 className="ml-1.5 min-w-0 flex-1 truncate text-[15px] font-semibold">{agent.name}</h2>
      )}
      {begun && children}
      <CloseChats />
    </header>
  );
}

/**
 * Your conversation with an agent: its head, what was said in it, and where the next thing is
 * written. One you have never begun is empty, with its box, until the first message makes it; it
 * stays the same view as it begins, so the box keeps the keyboard.
 */
export function Thread({
  agent,
  chat,
  other,
}: {
  agent: { id: string; name: string; tone: Tone };
  /** As the list has it, once it is listed. */
  chat?: ListedChat | undefined;
  /** The agent its conversation is with, when it is not yours: read here, never written in. */
  other?: { id: string; name: string; tone: Tone } | undefined;
}) {
  const { byId } = useAgents();
  const { read } = useAllChats();
  const connection = useConnection();
  const reduced = useReducedMotion();
  const entry = chat?.entry;
  const watched = byId.get(agent.id);
  const slot = watched?.slot;
  // Its agent's computer, as a window beside the chat: pressed again, it closes. The chat stays
  // as it is.
  const computers = useComputers();
  const hasComputer = windowsOf(surfacesOf(watched?.detail)).length > 0;
  const beside = computers.shown === agent.id;
  // A stopped agent's chat is for reading: it has no composer until the agent starts.
  const state = watched?.entry.status.state;
  const off = state === "stopped";
  /** The record, in order, and the text still streaming by id. */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<ReadonlyMap<string, string>>(new Map());
  /** Whether the agent works, in this chat or another. */
  const [working, setWorking] = useState(false);
  /** A message was sent from here and the agent hasn't gone idle since: its reply may be coming. */
  const [sentHere, setSentHere] = useState(false);
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
  // A reply cut off by a problem never settles: it goes.
  const failed = !!entry?.problem;
  useEffect(() => {
    if (failed) setStreaming(new Map());
  }, [failed]);
  // A reply shown here is read.
  const replied = messages.findLast((m) => m.role === "assistant")?.at;
  useEffect(() => {
    if (replied && !other) read(agent.id, replied);
  }, [read, agent.id, replied, other]);
  /** Who the conversation is with, as its calls and events name the party. */
  const party = other?.id ?? PERSON;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` says when to read again.
  useEffect(() => {
    if (connection !== "open" || !slot) return;
    let live = true;
    // What is said in this conversation; one it has with anyone else is not here.
    const here = (payload: unknown) => (payload as { with: string }).with === party;
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
            limit: PAGE,
            ...(other ? { with: party } : {}),
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
          // The latest word on an id replaces the earlier.
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
          // A reply cut off when the agent was stopped never settles: it goes. Gone idle, it is
          // answering nothing sent from here.
          if (status.state === "idle") {
            setStreaming(new Map());
            setSentHere(false);
          }
        },
        { again: load },
      ),
    ];
    void load();
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, [slot, connection, state, party]);

  const recorded = new Set(messages.map((m) => m.id));
  const unrecorded = sending.filter((m) => !m.messageId || !recorded.has(m.messageId));
  // A chat awaits a reply while what was sent from here isn't in the record yet, and then while it
  // is the newest thing said and the agent works. The agent's status is for all its chats, so a
  // message sent elsewhere, or one whose turn ended unanswered, awaits nothing. Nothing is shown
  // for it: the agent's own line says it works.
  const asked = messages.at(-1)?.role === "user";
  const awaiting = unrecorded.length > 0 || (sentHere && working && asked);
  // While it awaits a reply its problem is not said: the reply ends it, or it is said again. A
  // call of this thread's that failed is said in its place.
  const problem = failure || awaiting ? undefined : entry?.problem;
  const wrong = failure?.said ?? problem?.message;
  // A problem that the plan's page can fix ends its line with the way there.
  const fix = problem && fixOf(problem);
  const turns = useMemo(
    () => turnsOf(messages, unrecorded, streaming, keys.current),
    [messages, unrecorded, streaming],
  );
  const lastTurn = turns.at(-1);

  const send = async (text: string, images: Sent[]) => {
    if (!slot) return false;
    setFailure(undefined);
    setSentHere(true);
    const key = `sending-${++sends.current}`;
    setSending((was) => [...was, { id: key, text, images }]);
    try {
      const { messageId } = await api.call<{ messageId: string }>(slot, "send", {
        text,
        ...(images.length > 0 ? { images } : {}),
      });
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
      }>(slot, "history", { before: oldest.id, limit: PAGE, ...(other ? { with: party } : {}) });
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
      <Head agent={agent} other={other} begun={!!chat}>
        {hasComputer && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${agent.name}'s computer`}
            aria-pressed={beside}
            className={beside ? "bg-[var(--selected)]" : ""}
            onClick={() => (beside ? computers.close() : computers.open(agent.id))}
          >
            <MonitorIcon />
          </Button>
        )}
      </Head>
      {/* What is said is followed to its end as it comes, until the person scrolls away. */}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <Room>
            {/* Room above the first message; with none yet, what went wrong is at the top. */}
            <MessageScrollerContent
              className={`mx-auto w-full max-w-[720px] gap-6 px-4 pb-4 ${turns.length > 0 ? "pt-3" : ""}`}
            >
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
                        {/* Between two agents, who said it. */}
                        {other && (
                          <span className="pr-3 text-right text-[13px] text-muted-foreground">
                            {other.name}
                          </span>
                        )}
                        {/* The pictures sent with it, above its words, each at its own shape. */}
                        {turn.images.map((image, n) => (
                          <span
                            // biome-ignore lint/suspicious/noArrayIndexKey: the same picture may be sent twice.
                            key={n}
                            className="window relative self-end overflow-hidden rounded-2xl"
                          >
                            <img
                              src={sourceOf(image)}
                              // biome-ignore lint/a11y/noRedundantAlt: each is named by its place, as the person counts them.
                              alt={`Picture ${n + 1}`}
                              className="block max-h-56 max-w-[280px]"
                            />
                          </span>
                        ))}
                        {turn.text && (
                          <Bubble variant="secondary" align="end">
                            <BubbleContent className="rounded-3xl px-4 py-2 text-[15px] whitespace-pre-wrap">
                              {turn.text}
                            </BubbleContent>
                          </Bubble>
                        )}
                      </MessageContent>
                    </Message>
                  ) : (
                    <Reply
                      parts={turn.parts}
                      reduced={reduced}
                      isLast={turn === lastTurn}
                      awaiting={awaiting}
                    />
                  )}
                </MessageScrollerItem>
              ))}
              {wrong && <ProblemLine fix={fix}>{wrong}</ProblemLine>}
            </MessageScrollerContent>
          </Room>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {/* One between two agents is read here, never written in. */}
      {!off && !other && (
        <div className="mx-auto w-full max-w-[720px] shrink-0 px-3 pb-3">
          <Composer name={agent.name} draft={agent.id} onSend={send} />
        </div>
      )}
    </div>
  );
}

/** How soon after a person moves the room its having moved is theirs, and not what came. */
const THEIRS_MS = 400;

/**
 * The room a chat is read in. The scroller follows a reply to its end once the reply has filled
 * the room under the message it answers. Where that never happens, as under a chat's first
 * message, which is at the top already, the end is gone to here when what came passes the foot.
 * A person who has scrolled away is past the foot already, so nothing moves them.
 */
function Room({ children }: { children: React.ReactNode }) {
  const { scrollToEnd } = useMessageScroller();
  const { end: more } = useMessageScrollerScrollable();
  const moved = useRef(0);
  const theirs = () => {
    moved.current = Date.now();
  };
  useEffect(() => {
    if (more && Date.now() - moved.current > THEIRS_MS) scrollToEnd({ behavior: "auto" });
  }, [more, scrollToEnd]);
  return (
    <MessageScrollerViewport
      className="no-bar"
      onWheel={theirs}
      onTouchMove={theirs}
      onKeyDown={theirs}
    >
      {children}
    </MessageScrollerViewport>
  );
}

function Reply({
  parts,
  reduced,
  isLast,
  awaiting,
}: {
  parts: Part[];
  reduced: boolean;
  isLast: boolean;
  /** The chat still awaits its reply: the last one isn't settled, and offers nothing yet. */
  awaiting: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const texts = parts.map((part) => part.text);
  const settled = !(isLast && (awaiting || parts.some((p) => p.streaming)));
  /** Nothing in it has words: there is nothing to copy. */
  const wordless = texts.every((text) => !text.trim());
  return (
    <Message className="group/reply">
      <MessageContent className="gap-2">
        {parts.map((part) => (
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
        ))}
        {/* Its room is always kept, so nothing moves when it appears. */}
        <MessageFooter
          className={`h-6 gap-0.5 px-0 ${!settled || wordless ? "invisible" : isLast ? "" : "invisible group-hover/reply:visible"}`}
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

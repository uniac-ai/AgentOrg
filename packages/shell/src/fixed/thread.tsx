// One chat, over its agent's `chat@1`: a title, one agent, its messages; and a chat about to be
// started. The record is the chat's and whether it works is the agent's. A chat has no Stop and
// no model to choose: its work is stopped by saying so in it, and the model is the agent's, in
// its setup.
import { MESSAGE_TEXT_MAX, PICTURES_MAX } from "@agentorg/interfaces";
import { NotConnected } from "@agentorg/sdk";
import {
  ArrowUpIcon,
  ChevronLeftIcon,
  CopyIcon,
  LoaderCircleIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import { api, go, useConnection } from "../data.ts";
import { Bubble, BubbleContent, BubbleGroup, BubbleReactions } from "../ui/bubble.tsx";
import { Button } from "../ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import GradualBlur from "../ui/gradual-blur.tsx";
import { Marker, MarkerContent } from "../ui/marker.tsx";
import { Message, MessageContent } from "../ui/message.tsx";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { type ListedChat, PERSON, useAllChats } from "./all-chats.tsx";
import { AskCard, type CardState } from "./ask.tsx";
import { bubblesOf, isCode } from "./bubbles.ts";
import { CloseChats, timeOf } from "./chat-parts.tsx";
import { useChats } from "./chats.tsx";
import { surfacesOf, windowsOf } from "./computer.tsx";
import { useComputers } from "./computers.tsx";
import {
  type Answer,
  type Ask,
  type ChatMessage,
  type ChatStatus,
  type Progress,
  type ProgressSaid,
  reasonOf,
  type Tone,
  WORD,
} from "./data.ts";
import { Face, type Faced, MARK } from "./face.tsx";
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
  /** A card's answer, sent alone: the card shows it, and its words are the provider's to write. */
  answer?: Answer;
  messageId?: string;
}

/** What the thread shows: each message of the person, and each of the agent's, on its own. */
type Turn =
  | {
      kind: "user";
      id: string;
      message?: string;
      text: string;
      images: readonly Sent[];
      /** A card's answer: drawn by its card, never as a bubble, though it is the party's turn. */
      answer?: Answer;
    }
  | { kind: "agent"; id: string; text: string; at: string; ask?: Ask };

function turnsOf(
  messages: readonly ChatMessage[],
  unrecorded: readonly Sending[],
  keys: ReadonlyMap<string, string>,
): Turn[] {
  const turns: Turn[] = [];
  // Each of the agent's messages is its own, known by its id, and drawn once it has come whole:
  // earlier messages read in above it change nothing.
  for (const message of messages) {
    if (message.role === "user")
      turns.push({
        kind: "user",
        id: keys.get(message.id) ?? message.id,
        message: message.id,
        text: message.text,
        images: message.images ?? [],
        ...(message.answer ? { answer: message.answer } : {}),
      });
    else
      turns.push({
        kind: "agent",
        id: message.id,
        text: message.text,
        at: message.at,
        ...(message.ask ? { ask: message.ask } : {}),
      });
  }
  for (const { id, messageId, text, images, answer } of unrecorded)
    turns.push({
      kind: "user",
      id,
      ...(messageId ? { message: messageId } : {}),
      text,
      images,
      ...(answer ? { answer } : {}),
    });
  return turns;
}

/** Where a message is written, and nothing else. What's half typed waits there, in this session. */
function Composer({
  name,
  draft,
  onSend,
  onRefused,
}: {
  name: string;
  /** Whose half-typed text this is: a chat's, or a chat about to be started with an agent. */
  draft: string;
  /** Sends it; false when it wasn't taken, and the text and pictures stay. */
  onSend(text: string, images: Sent[]): Promise<boolean>;
  /** It can't be sent as it is: why, in a person's words. */
  onRefused(why: string): void;
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
    // Longer than a message's text can be, nothing is sent, and the box stays just as it is.
    if (body.length > MESSAGE_TEXT_MAX)
      return onRefused(
        `That's too long to send: a message can be at most ${MESSAGE_TEXT_MAX.toLocaleString()} characters. This one has ${body.length.toLocaleString()}.`,
      );
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
  // Signed out of the model account, nothing can be sent: its place says why and holds the way in,
  // whole, in a box with the corners, ground and line of the one it stands for.
  if (needs)
    return (
      // biome-ignore lint/a11y/useSemanticElements: one place with its name, not a set of fields.
      <div
        role="group"
        aria-label="Sign in to send"
        className={`${BOX} flex min-h-[108px] flex-col justify-center gap-2.5 px-4 py-3.5`}
      >
        <span className="px-1 text-[15px] leading-5">{needs}</span>
        <SignInButton className="w-full" />
      </div>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: one place to write in, with its buttons, not a set of fields.
    <div role="group" data-slot="input-group" className={`${BOX} flex flex-col`}>
      {/* What is to be sent with the words, above them. Each can be taken out again, by a mark shown when it is pointed at. */}
      {box.pictures.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
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
        </div>
      )}
      {/* One line: the plus, the words and Send. As the words take more lines the box grows up
          from its foot, and the two buttons stay on the last line. */}
      <div className="flex items-end gap-1 px-2">
        {/* The way to pick a picture, for one that isn't pasted. */}
        <Button
          size="icon"
          variant="ghost"
          className="mb-2 shrink-0 rounded-full text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)] dark:hover:bg-[var(--hover)]"
          aria-label="Attach a picture"
          onClick={() => picker.current?.click()}
        >
          <PlusIcon className="size-5" />
        </Button>
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
        <textarea
          ref={words}
          aria-label="Message"
          placeholder={`Message ${name}`}
          rows={1}
          // One line of 24 between 12 above and below. It grows with what is written, to about two
          // fifths of the chat; past that it scrolls, so the thread, and what went wrong above it,
          // stay in view.
          className="field-sizing-content max-h-[40dvh] min-h-12 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-3 text-[15px] leading-6 outline-none placeholder:text-[var(--muted)]"
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
        <Button
          size="icon"
          variant="default"
          className="mb-2 shrink-0 rounded-full"
          aria-label="Send"
          disabled={!ready}
          onClick={() => void submit()}
        >
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
  );
}

/** The box a message is written in, and the one that stands for it signed out: raised, round, with its line. */
const BOX = "chat-box w-full min-w-0 rounded-3xl bg-[var(--raised)]";

/**
 * What went wrong, in the one line a chat says it in, the whole of it where a pointer rests on it;
 * and what helps, where something does.
 */
const ProblemLine = ({
  children,
  fix,
}: {
  children: string;
  fix?: { label: string; run(): void } | undefined;
}) => (
  <div role="alert" className="flex h-8 items-center gap-3 text-[15px] text-[var(--bad)]">
    <span className="min-w-0 truncate" title={children}>
      {children}
    </span>
    {fix && (
      <Button variant="secondary" size="sm" className="shrink-0" onClick={fix.run}>
        {fix.label}
      </Button>
    )}
  </div>
);

/**
 * A bubble's corners: 18 px, and 6 px on its own side where it meets what the same side said just
 * above it or just under it, so a run of one side's bubbles reads as one group.
 */
const corners = (side: "start" | "end", above: boolean, below: boolean) =>
  [
    "rounded-[18px]",
    above && (side === "start" ? "rounded-ss-[6px]" : "rounded-se-[6px]"),
    below && (side === "start" ? "rounded-es-[6px]" : "rounded-ee-[6px]"),
  ]
    .filter(Boolean)
    .join(" ");

/**
 * The agent typing in this conversation, as a messenger shows the other end typing: three dots in a
 * muted bubble on its side, heard as "<agent> is typing". The dots rise in turn, and stay still for
 * a person who asks for less motion. Under a message that came while the conversation was open, it
 * comes in as that message did.
 */
const TypingSign = ({ name, came }: { name: string; came: boolean }) => (
  <Message>
    <MessageContent>
      <Bubble
        variant="muted"
        role="status"
        aria-label={`${name} is typing`}
        className={`max-w-[80%] ${came ? "message-in" : ""}`}
      >
        <BubbleContent
          className={`flex h-10 items-center gap-1 px-4 ${corners("start", false, false)}`}
        >
          <span className="sr-only">{name} is typing</span>
          {[0, 1, 2].map((n) => (
            <span
              key={n}
              aria-hidden
              className="typing-dot size-1.5 rounded-full bg-current"
              style={{ animationDelay: `${n * 160}ms` }}
            />
          ))}
        </BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
);

/**
 * Where a conversation is drawn: the chat page rather than the chat, and what its way back to the
 * list does where the list isn't beside it.
 */
export interface OnPage {
  back?: () => void;
  /** Opens the agent's details beside the conversation, or closes them, where there is room. */
  details?: (() => void) | undefined;
}

/** How tall the head is, which it covers at the top of the room: taller with the read-only line. */
const HEAD = { alone: 90, read: 110 } as const;

/** The mark before a state's word in the head's pill: the face's own marks, and grey otherwise. */
function StateMark({ tone }: { tone: Tone }) {
  if (tone === "starting")
    return (
      <LoaderCircleIcon
        aria-hidden
        className="size-3 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
    );
  return (
    <span
      aria-hidden
      className={`size-1.5 rounded-full ${MARK[tone] ?? "bg-muted-foreground/50"}`}
    />
  );
}

/**
 * The head of your conversation with an agent: in the middle, its face in a round frame, which
 * goes to its details, standing on a pill with its state in a word, the frame and the pill centred
 * together in the head; back to the list at its start; its computer, begun or not, at its end. The agent's name heads it for
 * those who hear the page, not drawn. One between two agents is named by both, and says under the
 * pill that it is there to be read. On the chat page it has no close, and a way back only where the
 * list isn't beside it. It takes no room of its own: it lies over the top of the room, where what
 * is said goes up behind it, and only its buttons take the pointer, so anywhere else on it the room
 * is scrolled and pressed as if it weren't there.
 */
function Head({
  agent,
  other,
  page,
  children,
}: {
  agent: Faced;
  other?: { name: string } | undefined;
  page?: OnPage | undefined;
  children?: React.ReactNode;
}) {
  const { show, close } = useChats();
  const back = page ? page.back : () => show({ kind: "list" });
  return (
    <header
      className="pointer-events-none absolute inset-x-0 top-0 z-20 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-x-2.5 px-2.5 pt-1 [&_button]:pointer-events-auto"
      style={{ height: other ? HEAD.read : HEAD.alone }}
    >
      <h2 className="sr-only">{other ? `${agent.name} and ${other.name}` : agent.name}</h2>
      {/* The ends' controls on one line through the middle of the frame and its pill together. */}
      <div className="flex h-[82px] items-center">
        {back && (
          <Button variant="ghost" size="icon-sm" aria-label="All chats" onClick={back}>
            <ChevronLeftIcon />
          </Button>
        )}
      </div>
      <div className="flex flex-col items-center">
        <button
          type="button"
          aria-label={`${agent.name}'s details`}
          className="relative z-10 grid size-15 place-items-center overflow-hidden rounded-full border border-[var(--line-strong)] bg-[var(--surface)] shadow-[var(--card-shadow)]"
          onClick={() => {
            // Beside the conversation where the page has room; else on the team page.
            if (page?.details) return page.details();
            go({ screen: "team", agent: agent.id });
            // The chat is put away; the chat page leaves it as it was.
            if (!page) close();
          }}
        >
          <Face agent={agent} size={48} plain live />
        </button>
        {/* Behind the frame's foot, 7 px of it under the frame: its words are in the 22 px below,
            a quieter line and shadow than the frame's. */}
        <div className="-mt-[7px] flex h-[29px] items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--surface)] px-2.5 pt-[7px] text-xs leading-4 whitespace-nowrap shadow-[0_1px_2px_rgb(0_0_0/0.06)]">
          <StateMark tone={agent.tone} />
          {WORD[agent.tone]}
        </div>
        {other && (
          <div className="mt-1 text-xs leading-4 whitespace-nowrap text-muted-foreground">
            You can read it, not write in it
          </div>
        )}
      </div>
      <div className="flex h-[82px] items-center gap-1 justify-self-end">
        {children}
        {!page && <CloseChats />}
      </div>
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
  page,
}: {
  agent: Faced;
  /** As the list has it, once it is listed. */
  chat?: ListedChat | undefined;
  /** The agent its conversation is with, when it is not yours: read here, never written in. */
  other?: Faced | undefined;
  /** Drawn on the chat page rather than in the chat. */
  page?: OnPage | undefined;
}) {
  const { byId } = useAgents();
  const { read, opened } = useAllChats();
  const connection = useConnection();
  const entry = chat?.entry;
  // Yours, opened: it is on the list, had it been taken off.
  const yours = !other;
  useEffect(() => {
    if (yours) opened(agent.id);
  }, [opened, agent.id, yours]);
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
  /** The record, in order. */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** Where each message that came in stands, by its id, as the record and the latest word say. */
  const [progress, setProgress] = useState<ReadonlyMap<string, Progress>>(new Map());
  /** The messages whose emoji came while the conversation was open: it grows in. One read with it is simply there. */
  const reacted = useRef(new Set<string>());
  /**
   * What came while the conversation was open, either side's, by the id it is drawn under: it
   * rises in. What was read with the conversation, or read in above it, is simply there.
   */
  const came = useRef(new Set<string>());
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
     * The record and the status now. Only what arrives while the record is read is newer than
     * it.
     */
    /** Whether the status was said while the record was being read: that is the newer word. */
    let heard = false;
    const load = async () => {
      /** What is shown as the read begins: anything else shown when it ends came meanwhile. */
      const before = new Set(shown.current.map((m) => m.id));
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
        // A read again takes back nothing shown: earlier pages stay above the newest one, and what
        // came while it was read stays below it.
        const was = shown.current;
        const first = was.findIndex((m) => known.has(m.id));
        const older = first > 0 ? was.slice(0, first) : [];
        const newer = was.filter(
          (m, i) => i >= Math.max(first, 0) && !known.has(m.id) && !before.has(m.id),
        );
        setMessages([...older, ...page, ...newer]);
        // A page opened late reads where each message stands from the record.
        setProgress((was) => {
          const said = page.filter((m) => m.progress);
          if (said.length === 0) return was;
          const next = new Map(was);
          for (const m of said) if (m.progress) next.set(m.id, m.progress);
          return next;
        });
        // With earlier pages kept, whether there are earlier still is as their read said.
        if (older.length === 0) setHasEarlier(more);
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
          if (!shown.current.some((m) => m.id === message.id)) came.current.add(message.id);
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
        "progress",
        (payload) => {
          if (!here(payload)) return;
          const { id, state, step, reaction } = payload as ProgressSaid;
          if (reaction) reacted.current.add(id);
          // The latest word on a message replaces the earlier, all but the emoji it was closed with:
          // that comes once, with the close, and stays.
          setProgress((was) => {
            const kept = reaction ?? was.get(id)?.reaction;
            return new Map(was).set(id, {
              state,
              ...(step ? { step } : {}),
              ...(kept ? { reaction: kept } : {}),
            });
          });
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
          // Gone idle, it is answering nothing sent from here.
          if (status.state === "idle") setSentHere(false);
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
  /** Whether a message is in hand: its chat's problem waits while one is. */
  const taken = (now: Progress | undefined) => now?.state === "taken";
  const holding = [...progress.values()].filter(taken);
  // While it awaits a reply its problem is not said: the reply ends it, or it is said again. A
  // call of this thread's that failed is said in its place. While a message is in hand, a problem
  // is said once nothing is.
  const problem = failure || awaiting || holding.length > 0 ? undefined : entry?.problem;
  const wrong = failure?.said ?? problem?.message;
  // A problem that the plan's page can fix ends its line with the way there.
  const fix = problem && fixOf(problem);
  const turns = useMemo(() => turnsOf(messages, unrecorded, keys.current), [messages, unrecorded]);
  const lastTurn = turns.at(-1);
  /** The emoji the agent closed one of the party's messages with, drawn on its bubble. */
  const reactionOf = (turn: Turn) =>
    turn.kind === "user" && turn.message && turn.text
      ? progress.get(turn.message)?.reaction
      : undefined;
  // The agent types here, one sign at the conversation's end, while all four hold: it works; the
  // newest thing said here is the party's, just sent or recorded; that message is taken or not yet
  // heard of; and the conversation has no problem. So a message from the agent (a receipt counts),
  // one closed with no reply, or its turn's end takes it away: its reply is drawn once it has come
  // whole, in the sign's place. Two messages sent show one sign. A call of this page's own that
  // failed is said at once, and the sign gives way to it: one or the other, never both.
  const newest = lastTurn?.kind === "user" ? lastTurn : undefined;
  const where = newest?.message === undefined ? undefined : progress.get(newest.message);
  const typing = working && !!newest && (!where || taken(where)) && !entry?.problem && !failure;
  // What became of each card. Answered: a message of the party's names it, recorded or just sent.
  // Passed over: the party sent anything after it, or a newer card came. Open: the newest, once
  // the agent's turn has ended; until then it isn't drawn.
  const newestCard = turns.findLast((turn) => turn.kind === "agent" && turn.ask)?.id;
  const cardOf = (turn: Turn, n: number): CardState | undefined => {
    if (turn.kind !== "agent" || !turn.ask) return;
    for (const one of turns)
      if (one.kind === "user" && one.answer?.to === turn.id)
        return { kind: "answered", picks: one.answer.picks };
    if (turn.id !== newestCard || turns.slice(n + 1).some((one) => one.kind === "user"))
      return { kind: "passed" };
    return working || typing ? undefined : { kind: "open" };
  };
  // What is drawn: each turn but a card's answer, which its card shows. Each knows the turn before
  // it and the one after, drawn or not, for the room between them and the corners where they meet.
  const drawn = turns.flatMap((turn, n) =>
    turn.kind === "user" && turn.answer
      ? []
      : [
          {
            turn,
            card: cardOf(turn, n),
            after: turns[n - 1]?.kind,
            before: turns[n + 1]?.kind,
          },
        ],
  );

  /** Sends words and pictures, or a card's answer alone. */
  const send = async (text: string, images: Sent[], answer?: Answer) => {
    if (!slot) return false;
    setFailure(undefined);
    setSentHere(true);
    const key = `sending-${++sends.current}`;
    came.current.add(key);
    setSending((was) => [...was, { id: key, text, images, ...(answer ? { answer } : {}) }]);
    try {
      const { messageId } = await api.call<{ messageId: string }>(
        slot,
        "send",
        answer ? { answer } : { text, ...(images.length > 0 ? { images } : {}) },
      );
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

  /** How much of the room's top the head covers. */
  const deep = other ? HEAD.read : HEAD.alone;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Head agent={agent} other={other} page={page}>
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
          {/* From the room's top, behind the head and 40 px under it, what is said goes up into a
              blur and the conversation's ground. Both are whole behind the head's frame and pill,
              which stay plain to read, and fade downward to nothing under it. Scrolled to its
              start, the room has neither. */}
          <GradualBlur
            position="top"
            height={deep + 40}
            curve="ease-out"
            tint="var(--thread)"
            autoHide
            zIndex={10}
          />
          <Room sent={sends.current}>
            {/* The head's own height, which it covers, then room above the first message; with
                none yet, what went wrong is first under the head. */}
            <MessageScrollerContent
              className="mx-auto w-full max-w-[720px] gap-6 px-4 pb-4"
              style={{ paddingTop: turns.length > 0 ? deep + 12 : deep }}
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
              {drawn.map(({ turn, card, after, before }) => (
                <MessageScrollerItem
                  key={turn.id}
                  // A reacted message keeps the room its emoji hangs into, so what follows is as far
                  // from the emoji as it would be from the bubble.
                  className={`[content-visibility:visible] ${after === undefined ? "" : after === turn.kind ? SAME_SIDE : SIDE_CHANGES} ${reactionOf(turn) ? "pb-6" : ""}`}
                >
                  {turn.kind === "user" ? (
                    <Message
                      align="end"
                      className={came.current.has(turn.id) ? "message-in" : undefined}
                    >
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
                            <BubbleContent
                              className={`${corners("end", after === "user", before === "user")} px-4 py-2 text-[15px] whitespace-pre-wrap`}
                            >
                              {turn.text}
                            </BubbleContent>
                            {/* On the bubble's foot at its end corner, as a messenger puts one: 8 px past
                                the end, and 4 px over the foot, 6 px with its ring, inside the bubble's
                                8 px under the words, so it never meets them. Its ring is the
                                conversation's ground, which cuts it out of the bubble. */}
                            {reactionOf(turn) && (
                              <BubbleReactions
                                role="img"
                                aria-label={`${agent.name} reacted ${reactionOf(turn)}`}
                                className={`-right-2 translate-y-6 ring-[var(--thread)] ${turn.message && reacted.current.has(turn.message) ? "reaction-in" : ""}`}
                              >
                                {reactionOf(turn)}
                              </BubbleReactions>
                            )}
                          </Bubble>
                        )}
                      </MessageContent>
                    </Message>
                  ) : (
                    <>
                      <Reply
                        text={turn.text}
                        at={turn.at}
                        came={came.current.has(turn.id)}
                        above={after === "agent"}
                        below={before === "agent"}
                      />
                      {/* The agent's question, its own part: 4 px under its words, or alone. Only
                          the party answers it, and only while the agent is there to read it. */}
                      {card && turn.ask && (
                        <div className={turn.text ? "mt-1" : undefined}>
                          <AskCard
                            ask={turn.ask}
                            agent={agent.name}
                            state={card}
                            onAnswer={
                              off || other
                                ? undefined
                                : (picks) => void send("", [], { to: turn.id, picks })
                            }
                          />
                        </div>
                      )}
                    </>
                  )}
                </MessageScrollerItem>
              ))}
              {/* Drawn at its own height from its first frame, as each turn is, and not at the
                  scroller's stand-in height for an item not yet drawn: the end the room goes to as
                  the sign comes is the end it keeps. */}
              {typing && (
                <MessageScrollerItem className={`[content-visibility:visible] ${SIDE_CHANGES}`}>
                  <TypingSign name={agent.name} came={!!newest && came.current.has(newest.id)} />
                </MessageScrollerItem>
              )}
              {/* The conversation's own problem never shows with the sign (see `typing`), and the
                  sign gives way to a failure of this page's own. */}
              {wrong && <ProblemLine fix={fix}>{wrong}</ProblemLine>}
            </MessageScrollerContent>
          </Room>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {/* One between two agents is read here, never written in. */}
      {!off && !other && (
        <div className="mx-auto w-full max-w-[720px] shrink-0 px-3 pb-3">
          <Composer
            name={agent.name}
            draft={agent.id}
            onSend={send}
            onRefused={(said) => setFailure({ said })}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The room between two messages, in place of the list's 24 px between its items: 4 px between two
 * of one side's, as between one message's bubbles, and 16 px where the side changes and before the
 * agent's typing sign.
 */
const SAME_SIDE = "-mt-5";
const SIDE_CHANGES = "-mt-2";

/** How near its end the room is at it, as the scroller counts it. */
const AT_END = 8;

/**
 * The room a chat is read in. The scroller keeps its end in view as what is said comes, so the
 * latest message is at its foot, until the room is scrolled away; from the end it follows again.
 *
 * The room itself only ever goes down, to its end. A scroll up that leaves it short of its end is
 * therefore someone else's, however it was made: the wheel, a touch, a key, the browser finding
 * words in an earlier message, or a script showing one. It is left where it was put, and nothing
 * moves it but its being scrolled to its end again, or a message of the person's own, which is
 * always gone to. A person who moved the wheel while all of it was in view has scrolled nothing:
 * the end is gone to here when what came passes the foot.
 */
function Room({
  sent,
  children,
}: {
  /** How many messages the person has sent from here. */
  sent: number;
  children: React.ReactNode;
}) {
  const { scrollToEnd } = useMessageScroller();
  const { end: more } = useMessageScrollerScrollable();
  /** Whether the room was scrolled away from its end, and where it was when it last scrolled. */
  const away = useRef(false);
  const top = useRef(0);
  useEffect(() => {
    if (more && !away.current) scrollToEnd({ behavior: "auto" });
  }, [more, scrollToEnd]);
  useEffect(() => {
    if (sent) scrollToEnd({ behavior: "auto" });
  }, [sent, scrollToEnd]);
  // The room is made shorter as the box under it takes more lines. At its end, it keeps its end in
  // view in the frame it is made shorter in, so the latest message is never under the box.
  const room = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = room.current;
    if (!element) return;
    let height = element.clientHeight;
    const keep = new ResizeObserver(() => {
      const was = height;
      height = element.clientHeight;
      if (height < was && !away.current) element.scrollTop = element.scrollHeight;
    });
    keep.observe(element);
    return () => keep.disconnect();
  }, []);
  return (
    <MessageScrollerViewport
      ref={room}
      className="no-bar"
      onScroll={({ currentTarget: room }) => {
        const up = room.scrollTop < top.current;
        top.current = room.scrollTop;
        if (room.scrollHeight - room.scrollTop - room.clientHeight <= AT_END) away.current = false;
        else if (up) {
          away.current = true;
          // The scroller stops following at a wheel: it is told of this scroll as one, since for a
          // moment after a scroll of its own it takes a scroll up for its own too.
          room.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
        }
      }}
    >
      {children}
    </MessageScrollerViewport>
  );
}

/**
 * One of the agent's messages: its bubbles, which its blank lines make. Each bubble is filled as the
 * person's is, at the start side, as wide as its words up to 80%, 4 px apart; a code block keeps the
 * conversation's whole width and the frame code has, with no fill, and its own Copy. Nothing is
 * under the last. It is drawn once it has come whole, all its bubbles together; one that came
 * while the conversation was open rises in, as the person's does.
 */
function Reply({
  text,
  at,
  came,
  above,
  below,
}: {
  text: string;
  /** When it was sent. */
  at: string;
  /** It came while the conversation was open. */
  came: boolean;
  /** The agent's own message is just above it, or just under it: their bubbles meet. */
  above: boolean;
  below: boolean;
}) {
  const bubbles = useMemo(() => bubblesOf(text), [text]);
  return (
    <Message className={came ? "message-in" : undefined}>
      <MessageContent className="gap-2">
        <BubbleGroup className="gap-1">
          {bubbles.map((bubble, n) => {
            const code = isCode(bubble);
            const shape = code
              ? "w-full"
              : `${corners("start", above || n > 0, below || n < bubbles.length - 1)} px-4 py-2`;
            return (
              <ReplyBubble
                // biome-ignore lint/suspicious/noArrayIndexKey: a bubble is known by its place in its message.
                key={n}
                code={code}
                text={text}
                at={at}
              >
                {/* Its size is said here: the bubble's own would outrank a rule of the sheet's. */}
                <BubbleContent className={`prose-chat text-[15px] leading-[1.6] ${shape}`}>
                  <Streamdown controls={{ table: false, code: true }}>{bubble}</Streamdown>
                </BubbleContent>
              </ReplyBubble>
            );
          })}
        </BubbleGroup>
      </MessageContent>
    </Message>
  );
}

/** How long a press on a bubble is held before it opens the bubble's menu, as messengers do. */
const LONG_PRESS_MS = 500;

/**
 * One bubble of the agent's message. One with words has its "⋯" at its outer side; a long press on
 * it, held still, opens the same menu, as messengers do where there is no pointer. A code block's
 * bubble has its own Copy in its frame, and no menu.
 */
function ReplyBubble({
  code,
  text,
  at,
  children,
}: {
  code: boolean;
  /** The whole message's words, which its Copy copies. */
  text: string;
  /** When the message was sent. */
  at: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const held = useRef<{ timer?: ReturnType<typeof setTimeout>; x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const release = () => clearTimeout(held.current.timer);
  const menu = !code && !!text.trim();
  return (
    <Bubble
      variant={code ? "ghost" : "muted"}
      className={code ? "w-full" : "max-w-[80%]"}
      {...(menu
        ? {
            onPointerDown: (event: React.PointerEvent) => {
              release();
              held.current = {
                x: event.clientX,
                y: event.clientY,
                timer: setTimeout(() => setOpen(true), LONG_PRESS_MS),
              };
            },
            // Moved, it is a scroll or a selection, not a press.
            onPointerMove: (event: React.PointerEvent) => {
              if (Math.hypot(event.clientX - held.current.x, event.clientY - held.current.y) > 4)
                release();
            },
            onPointerUp: release,
            onPointerLeave: release,
            onPointerCancel: release,
          }
        : {})}
    >
      {children}
      {menu && <More text={text} at={at} open={open} setOpen={setOpen} />}
    </Bubble>
  );
}

/**
 * A bubble's "⋯", at its outer side, vertically centred, shown while the bubble is pointed at.
 * Pointed at itself for a second, it says "More". Pressed, it opens Copy, which copies the whole
 * message, with when the message was sent under it, in the words the chat list says it in.
 */
function More({
  text,
  at,
  open,
  setOpen,
}: {
  text: string;
  at: string;
  open: boolean;
  setOpen(open: boolean): void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={1000}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="More"
              className={`absolute top-1/2 left-full ml-1.5 -translate-y-1/2 rounded-full text-muted-foreground ${open ? "opacity-100" : "opacity-0 group-hover/bubble:opacity-100 focus-visible:opacity-100"}`}
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>More</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="right" className="min-w-36">
        <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(text)}>
          <CopyIcon />
          Copy
        </DropdownMenuItem>
        <p className="px-2 pt-0.5 pb-1.5 text-xs text-muted-foreground">{timeOf(at)}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

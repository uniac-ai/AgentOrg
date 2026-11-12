// Every agent's chats, as one list: what each is called, its last words, and whether it has said
// something you haven't read. A chat is read when its thread has shown its reply; when each was
// read is kept in the app's notes, so it survives restarts.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, useConnection } from "../data.ts";
import type { ChatEntry, ChatMessage, Tone } from "./data.ts";
import { useAgents } from "./watch.tsx";

export interface ListedChat {
  /** The agent it is with. */
  agent: { id: string; name: string; tone: Tone };
  entry: ChatEntry;
  /** Its last words, in one line. */
  words: string;
  /** Why its last message got no answer, until its next reply. */
  problem?: string;
  /** When something was last said in it. */
  at: string;
  /** Listed with the archived ones: it is archived, or its agent is stopped. */
  archived: boolean;
  unread: boolean;
}

interface AllChats {
  /** What was said last comes first. */
  chats: ListedChat[];
  /** Every agent there is has had its chats listed once, or said it couldn't: all are here. */
  listed: boolean;
  /** A chat's thread has shown a reply of its, said at `at`. */
  read(agent: string, chat: string, at: string): void;
}

const Context = createContext<AllChats>({ chats: [], listed: false, read: () => {} });
export const useAllChats = () => useContext(Context);

/** A chat's id is its agent's own: two agents can each have one of the same id. */
const keyOf = (agent: string, chat: string) => `${agent} ${chat}`;
const later = (a: string, b: string) => Date.parse(a) > Date.parse(b);

/** The note in the app's store: when each chat was last read, and since when replies count. */
const NOTE = "ui/read";
interface Note {
  /** When the note was begun: what was said before it counts as read. */
  since: string;
  /** By agent and chat, when the newest reply read was said. */
  at: Record<string, string>;
}
/** How long until a note that couldn't be read is asked for again. */
const RETRY_MS = 5_000;
/** A stored value that is a note: anything else is taken for none, and a note is begun. */
const isNote = (value: unknown): value is Note => {
  const note = value as Partial<Note> | undefined;
  return typeof note?.since === "string" && typeof note.at === "object" && note.at !== null;
};

/** Two copies of the note as one: each chat is read as far as either says. */
const joined = (stored: unknown, mine: Note): Note => {
  if (!isNote(stored)) return mine;
  const at = { ...stored.at };
  for (const [key, when] of Object.entries(mine.at)) {
    const theirs = at[key];
    if (!theirs || later(when, theirs)) at[key] = when;
  }
  return { since: stored.since, at };
};

/** When each chat was last read; nothing until the note is read, so nothing is taken for new. */
function useRead() {
  const connection = useConnection();
  const [note, setNote] = useState<Note>();
  const held = useRef<Note>(undefined);
  /** What was shown before the note was read: marked once it is. */
  const waiting = useRef(new Map<string, string>());
  const keep = useCallback((next: Note) => {
    held.current = next;
    setNote(next);
  }, []);

  useEffect(() => {
    if (connection !== "open" || note) return;
    let over = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api.call<{ value?: unknown }>("store", "get", { key: NOTE }).then(
        ({ value }) => {
          if (over) return;
          if (isNote(value)) keep(value);
          else {
            const begun = { since: new Date().toISOString(), at: {} };
            keep(begun);
            void api.call("store", "set", { key: NOTE, value: begun }).catch(() => {});
          }
          for (const [key, at] of waiting.current) mark.current(key, at);
          waiting.current.clear();
        },
        // Unread, it stays unknown: writing over it would lose what was read.
        () => {
          if (!over) timer = setTimeout(load, RETRY_MS);
        },
      );
    void load();
    return () => {
      over = true;
      clearTimeout(timer);
    };
  }, [connection, note, keep]);

  const mark = useRef((key: string, at: string) => {
    const was = held.current;
    if (!was) return void waiting.current.set(key, at);
    if (!later(at, was.at[key] ?? was.since)) return;
    keep({ ...was, at: { ...was.at, [key]: at } });
    // Another tab may have read other chats since this one read the note: both are kept.
    void api
      .call<{ value?: unknown }>("store", "get", { key: NOTE })
      .then(({ value }) =>
        api.call("store", "set", { key: NOTE, value: joined(value, held.current as Note) }),
      )
      .catch(() => {});
  });
  return { note, mark: mark.current };
}

interface Held {
  agent: string;
  entry: ChatEntry;
  words: string;
  /** When its last words were said, once they are known. */
  said?: string;
}
type Put = (key: string, change: (was: Held | undefined) => Held | undefined) => void;

/** How many of an agent's chats are asked for at once. */
const PAGE = 50;
/** How many of a chat's newest messages are read for the last thing said in it. */
const NEWEST = 10;

/** What a person or an agent said: a message with words. */
const isSaid = (message: ChatMessage) => message.text.trim() !== "";
/** A message as a chat's last words: who said it when it was you, and its first line. */
const wordsOf = (message: ChatMessage) => {
  const line = message.text.trim().split("\n")[0]?.replace(/[*`|]/g, "").trim() ?? "";
  return message.role === "user" ? `You: ${line}` : line;
};

/** One agent's chats, read from its own slot and followed from there. */
function Follow({
  agent,
  slot,
  state,
  put,
  done,
}: {
  agent: string;
  slot: string;
  /** Whether it runs: its chats are read again when that changes. */
  state: string;
  put: Put;
  /** Its chats that aren't archived have been listed, or couldn't be. */
  done(agent: string): void;
}) {
  const connection = useConnection();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` says when to read again.
  useEffect(() => {
    if (connection !== "open") return;
    let over = false;
    /** The chats whose last words have been asked for. */
    let asked = new Set<string>();
    /** One call for last words at a time, so a long list never crowds out the app's other calls. */
    let line: Promise<unknown> = Promise.resolve();

    const hears = (id: string, message: ChatMessage) => {
      if (!isSaid(message)) return;
      put(keyOf(agent, id), (was) =>
        // An answer that comes late never replaces what was said after it.
        was && !(was.said && later(was.said, message.at))
          ? { ...was, words: wordsOf(message), said: message.at }
          : undefined,
      );
    };
    const told = (entry: ChatEntry) => {
      put(keyOf(agent, entry.id), (was) => ({ agent, words: "", ...was, entry }));
      if (asked.has(entry.id)) return;
      asked.add(entry.id);
      line = line.then(async () => {
        if (over) return;
        const last = await api
          .call<{ messages: ChatMessage[] }>(slot, "history", { chat: entry.id, limit: NEWEST })
          .then((reply) => reply.messages.findLast(isSaid))
          .catch(() => undefined);
        if (last && !over) hears(entry.id, last);
      });
    };
    const list = async (archived: boolean) => {
      let before: string | undefined;
      do {
        const { chats, more }: { chats: ChatEntry[]; more: boolean } = await api.call(
          slot,
          "list",
          {
            archived,
            limit: PAGE,
            ...(before ? { before } : {}),
          },
        );
        if (over) return;
        for (const entry of chats) told(entry);
        before = more ? chats.at(-1)?.id : undefined;
      } while (before);
    };
    const load = () => {
      asked = new Set();
      // An agent that doesn't answer has no chats to show until it does.
      list(false)
        .catch(() => {})
        .finally(() => !over && done(agent));
      list(true).catch(() => {});
    };
    // Followed before it is read, so nothing said between the two is missed.
    const stops = [
      // A chat is told again when it is renamed or archived, something is said in it, or what was
      // said got no answer.
      api.subscribe(slot, "chat", (payload) => told(payload as ChatEntry), { again: load }),
      api.subscribe(slot, "message", (payload) => {
        const message = payload as ChatMessage & { chat: string };
        hears(message.chat, message);
      }),
    ];
    load();
    return () => {
      over = true;
      for (const stop of stops) stop();
    };
  }, [connection, agent, slot, state, put, done]);
  return null;
}

export function AllChatsProvider({ children }: { children: React.ReactNode }) {
  const { list, loaded, byId } = useAgents();
  const [heard, setHeard] = useState<ReadonlySet<string>>(new Set());
  const done = useCallback(
    (agent: string) => setHeard((was) => (was.has(agent) ? was : new Set(was).add(agent))),
    [],
  );
  // Only an agent whose chats were listed counts: one whose chats can't be reached yet isn't.
  const listed = loaded && list.every((entry) => heard.has(entry.agent));
  const [held, setHeld] = useState<ReadonlyMap<string, Held>>(new Map());
  const { note, mark } = useRead();
  const put = useCallback<Put>(
    (key, change) =>
      setHeld((was) => {
        const next = change(was.get(key));
        return next ? new Map(was).set(key, next) : was;
      }),
    [],
  );

  const chats = useMemo(
    () =>
      [...held.entries()]
        .flatMap(([key, { agent, entry, words, said }]): ListedChat[] => {
          // A deleted agent's chats go with it.
          const watched = byId.get(agent);
          if (!watched) return [];
          const problem = entry.problem?.message;
          return [
            {
              agent: { id: agent, name: watched.entry.name, tone: watched.now.tone },
              entry,
              words,
              ...(problem ? { problem } : {}),
              // Until its last words are known, its newest reply says when; else when it started.
              at: said ?? entry.latest?.at ?? entry.at,
              archived: entry.archived || watched.entry.status.state === "stopped",
              unread:
                !!note && !!entry.latest && later(entry.latest.at, note.at[key] ?? note.since),
            },
          ];
        })
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    [held, byId, note],
  );
  const read = useCallback<AllChats["read"]>((agent, id, at) => mark(keyOf(agent, id), at), [mark]);
  const value = useMemo(() => ({ chats, listed, read }), [chats, listed, read]);
  return (
    <Context.Provider value={value}>
      {[...byId.values()].map(
        ({ entry, slot }) =>
          slot && (
            <Follow
              key={entry.agent}
              agent={entry.agent}
              slot={slot}
              state={entry.status.state}
              put={put}
              done={done}
            />
          ),
      )}
      {children}
    </Context.Provider>
  );
}

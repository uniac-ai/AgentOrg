// Your conversations, one with each agent you talk to, as one list: its last words, and whether it
// has said something you haven't read; and apart, the agents' conversations with each other, which
// you read and never write in. A conversation of yours is read when its thread has shown its reply;
// when each was read is kept in the app's notes, so it survives restarts, and so are which of them
// you have pinned and which you have taken off the list.
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
import type { ChatMessage, Conversation } from "./data.ts";
import type { Faced } from "./face.tsx";
import { facedOf, useAgents } from "./watch.tsx";

export interface ListedChat {
  /** The agent whose conversation it is. */
  agent: Faced;
  /** Who it is with: you, or another agent by its id. */
  with: string;
  entry: Conversation;
  /** Its last words, in one line. */
  words: string;
  /** Why its last message got no answer, until its next reply. */
  problem?: string;
  /** When something was last said in it. */
  at: string;
  unread: boolean;
}

interface AllChats {
  /** Yours that are on the list, what was said last first. */
  chats: ListedChat[];
  /** The agents' conversations with other agents, what was said last first. */
  others: ListedChat[];
  /**
   * Every agent there is has had its chats listed once, or said it couldn't, and which of yours
   * are off the list is known: all are here.
   */
  listed: boolean;
  /** Your conversation with an agent has shown a reply of its, said at `at`. */
  read(agent: string, at: string): void;
  /** The agents whose conversations with you are pinned, in the order they were pinned. */
  pins: readonly string[];
  /**
   * Pins your conversation with an agent, or unpins it. Pinned, it is put just before the pinned
   * conversation of the agent `before`, or last, from wherever it was.
   */
  pin(agent: string, pinned: boolean, before?: string): void;
  /** The agents whose conversations with you are off the list. */
  hidden: readonly string[];
  /**
   * Takes your conversation with an agent off the list, and off the pinned ones. Nothing said in it
   * is cleared: it is back on the list once something is said in it, or it is opened.
   */
  hide(agent: string): void;
  /** Your conversation with an agent is open: it is on the list. */
  opened(agent: string): void;
}

const Context = createContext<AllChats>({
  chats: [],
  others: [],
  listed: false,
  read: () => {},
  pins: [],
  pin: () => {},
  hidden: [],
  hide: () => {},
  opened: () => {},
});
export const useAllChats = () => useContext(Context);

/** Who you are in a conversation, as the Hub names you. */
export const PERSON = "person";
/** A conversation is an agent's with one party. */
const keyOf = (agent: string, party: string) => `${agent} ${party}`;
const later = (a: string, b: string) => Date.parse(a) > Date.parse(b);

/**
 * The note in the app's store: when each conversation was last read, and since when replies count.
 * It is begun anew for conversations, so what chats said before them counts as read.
 */
const NOTE = "ui/read-conversations";
interface Note {
  /** When the note was begun: what was said before it counts as read. */
  since: string;
  /** By agent and party, when the newest reply read was said. */
  at: Record<string, string>;
}
/** How long until a note that couldn't be read is asked for again. */
const RETRY_MS = 5_000;
/** A stored value that is a note: anything else is taken for none, and a note is begun. */
const isNote = (value: unknown): value is Note => {
  const note = value as Partial<Note> | undefined;
  return typeof note?.since === "string" && typeof note.at === "object" && note.at !== null;
};

/** Two copies of the note as one: each conversation is read as far as either says. */
const joined = (stored: unknown, mine: Note): Note => {
  if (!isNote(stored)) return mine;
  const at = { ...stored.at };
  for (const [key, when] of Object.entries(mine.at)) {
    const theirs = at[key];
    if (!theirs || later(when, theirs)) at[key] = when;
  }
  return { since: stored.since, at };
};

/** When each conversation was last read; nothing until the note is read, so nothing is taken for new. */
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
    // Another tab may have read other conversations since this one read the note: both are kept.
    void api
      .call<{ value?: unknown }>("store", "get", { key: NOTE })
      .then(({ value }) =>
        api.call("store", "set", { key: NOTE, value: joined(value, held.current as Note) }),
      )
      .catch(() => {});
  });
  return { note, mark: mark.current };
}

/**
 * A value in the app's store that any tab may change, and whether it has been read: `none` until
 * then, and for a stored value that isn't one. A change is made to what is stored, since another
 * tab may have changed it
 * after this one read it; one that leaves it as it is writes nothing. This tab's changes are made
 * one after another, each to what the one before it stored.
 */
function useStored<T>(key: string, is: (value: unknown) => value is T, none: T) {
  const connection = useConnection();
  const [value, setValue] = useState<T>();
  useEffect(() => {
    if (connection !== "open" || value !== undefined) return;
    let over = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api.call<{ value?: unknown }>("store", "get", { key }).then(
        ({ value: stored }) => {
          if (!over) setValue(is(stored) ? stored : none);
        },
        () => {
          if (!over) timer = setTimeout(load, RETRY_MS);
        },
      );
    void load();
    return () => {
      over = true;
      clearTimeout(timer);
    };
  }, [connection, value, key, is, none]);

  const last = useRef<Promise<unknown>>(Promise.resolve());
  const change = useCallback(
    (to: (was: T) => T) => {
      setValue((was) => (was === undefined ? was : to(was)));
      last.current = last.current
        .then(() => api.call<{ value?: unknown }>("store", "get", { key }))
        .then(({ value: stored }) => {
          const was = is(stored) ? stored : none;
          const next = to(was);
          setValue(next);
          return next === was ? undefined : api.call("store", "set", { key, value: next });
        })
        .catch(() => {});
    },
    [key, is, none],
  );
  return [value ?? none, change, value !== undefined] as const;
}

/** The pins in the app's store: the agents whose conversations with you are pinned, in the order pinned. */
const PINS = "ui/pinned-conversations";
/** A stored value that is pins: anything else is taken for none. */
const isPins = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((one) => typeof one === "string");
const NO_PINS: readonly string[] = [];

/** Your pinned conversations; none until the pins are read. */
function usePins() {
  const [pins, change] = useStored(PINS, isPins, NO_PINS);
  const pin = useCallback(
    (agent: string, pinned: boolean, before?: string) =>
      change((was) => {
        const rest = was.filter((one) => one !== agent);
        if (!pinned) return rest;
        // Before one that isn't pinned, it goes last.
        const at = before === undefined ? -1 : rest.indexOf(before);
        return at < 0 ? [...rest, agent] : [...rest.slice(0, at), agent, ...rest.slice(at)];
      }),
    [change],
  );
  return { pins, pin };
}

/**
 * The conversations taken off the list, in the app's store: by agent, when each was taken off. One
 * is off the list until something is said in it after that, or it is opened.
 */
const HIDDEN = "ui/hidden-conversations";
type Hidden = Readonly<Record<string, string>>;
/** A stored value that is those: anything else is taken for none. */
const isHidden = (value: unknown): value is Hidden =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((one) => typeof one === "string");
const NONE_HIDDEN: Hidden = {};
/** Those, without the ones that are back on the list or whose agent is gone. */
const without = (was: Hidden, gone: (agent: string, at: string) => boolean): Hidden => {
  const kept = Object.entries(was).filter(([agent, at]) => !gone(agent, at));
  return kept.length === Object.keys(was).length ? was : Object.fromEntries(kept);
};

interface Held {
  agent: string;
  with: string;
  entry: Conversation;
  words: string;
  /** When its last words were said, once they are known. */
  said?: string;
}
type Put = (key: string, change: (was: Held | undefined) => Held | undefined) => void;

/** How many of an agent's conversations are asked for at once. */
const PAGE = 50;
/** How many of a conversation's newest messages are read for the last thing said in it. */
const NEWEST = 10;

/** What a person or an agent said: a message with words, or with pictures. */
const isSaid = (message: ChatMessage) =>
  message.text.trim() !== "" || (message.images?.length ?? 0) > 0;
/**
 * A message as a conversation's last words: who said it when it was you, and its first line. A
 * picture sent with no words is named, as its words would be.
 */
const wordsOf = (message: Pick<ChatMessage, "role" | "text" | "images">, party: string) => {
  const count = message.images?.length ?? 0;
  const line =
    message.text.trim().split("\n")[0]?.replace(/[*`|]/g, "").trim() ||
    (count === 1 ? "Picture" : count > 1 ? `${count} pictures` : "");
  return message.role === "user" && party === PERSON ? `You: ${line}` : line;
};

/** One agent's conversations, read from its own slot and followed from there. */
function Follow({
  agent,
  slot,
  state,
  put,
  done,
}: {
  agent: string;
  slot: string;
  /** Whether it runs: its conversations are read again when that changes. */
  state: string;
  put: Put;
  /** Its conversations have been listed, or couldn't be. */
  done(agent: string): void;
}) {
  const connection = useConnection();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` says when to read again.
  useEffect(() => {
    if (connection !== "open") return;
    let over = false;
    /** The parties whose conversation's last words have been asked for. */
    let asked = new Set<string>();

    const hears = (
      party: string,
      message: Pick<ChatMessage, "role" | "text" | "images" | "at">,
    ) => {
      if (!isSaid(message as ChatMessage)) return;
      put(keyOf(agent, party), (was) =>
        // An answer that comes late never replaces what was said after it.
        was && !(was.said && later(was.said, message.at))
          ? { ...was, words: wordsOf(message, party), said: message.at }
          : undefined,
      );
    };
    // Each of its conversations, yours or another agent's with it.
    const told = (entry: Conversation) => {
      const party = entry.with;
      put(keyOf(agent, party), (was) =>
        // A list read while the conversation changed never replaces what an event said since.
        was?.entry.latest && (!entry.latest || later(was.entry.latest.at, entry.latest.at))
          ? undefined
          : { agent, with: party, words: "", ...was, entry },
      );
      const { latest } = entry;
      // Its latest words come with it; a message of pictures alone is read to be named.
      if (latest && isSaid(latest as ChatMessage)) return hears(party, latest);
      if (!latest || asked.has(party)) return;
      asked.add(party);
      void api
        .call<{ messages: ChatMessage[] }>(slot, "history", {
          limit: NEWEST,
          ...(party === PERSON ? {} : { with: party }),
        })
        .then((reply) => reply.messages.findLast(isSaid))
        .then((last) => last && !over && hears(party, last))
        .catch(() => {});
    };
    const load = async () => {
      asked = new Set();
      let before: string | undefined;
      do {
        const { conversations, more }: { conversations: Conversation[]; more: boolean } =
          await api.call(slot, "list", { limit: PAGE, ...(before ? { before } : {}) });
        if (over) return;
        for (const entry of conversations) told(entry);
        before = more ? conversations.at(-1)?.with : undefined;
      } while (before);
    };
    const reload = () => {
      // An agent that doesn't answer has no conversations to show until it does.
      load()
        .catch(() => {})
        .finally(() => !over && done(agent));
    };
    // Followed before it is read, so nothing said between the two is missed.
    const stops = [
      // A conversation is told again when it begins, something is said in it, or what was said got
      // no answer.
      api.subscribe(slot, "chat", (payload) => told(payload as Conversation), { again: reload }),
      api.subscribe(slot, "message", (payload) => {
        const message = payload as ChatMessage & { with: string };
        hears(message.with, message);
      }),
    ];
    reload();
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
  // Only an agent whose conversations were listed counts: one that can't be reached yet isn't.
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

  const all = useMemo(
    () =>
      [...held.entries()]
        .flatMap(([key, { agent, with: party, entry, words, said }]): ListedChat[] => {
          // A deleted agent's conversation goes with it.
          const watched = byId.get(agent);
          if (!watched) return [];
          const problem = entry.problem?.message;
          const { latest } = entry;
          return [
            {
              agent: facedOf(watched),
              with: party,
              entry,
              words,
              ...(problem ? { problem } : {}),
              // Until its last words are known, its latest message says when; else when it began.
              at: said ?? latest?.at ?? entry.at,
              // A reply to you is new until it is read.
              unread:
                !!note &&
                party === PERSON &&
                latest?.role === "assistant" &&
                later(latest.at, note.at[key] ?? note.since),
            },
          ];
        })
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    [held, byId, note],
  );
  const mine = useMemo(() => all.filter((one) => one.with === PERSON), [all]);
  const others = useMemo(() => all.filter((one) => one.with !== PERSON), [all]);
  const read = useCallback<AllChats["read"]>((agent, at) => mark(keyOf(agent, PERSON), at), [mark]);
  const { pins, pin } = usePins();
  const [off, change, offRead] = useStored(HIDDEN, isHidden, NONE_HIDDEN);
  /** Whether something was said in a conversation after it was taken off the list. */
  const saidSince = useCallback(
    (agent: string, at: string) => {
      const said = mine.find((one) => one.agent.id === agent)?.at;
      return !!said && later(said, at);
    },
    [mine],
  );
  const isOff = useCallback(
    ({ agent }: ListedChat) => {
      const at = off[agent.id];
      return at !== undefined && !saidSince(agent.id, at);
    },
    [off, saidSince],
  );
  // Until which are off the list is read, none is listed: one that is off is never shown, or
  // opened by the page, in the meantime.
  const chats = useMemo(
    () => (offRead ? mine.filter((one) => !isOff(one)) : []),
    [mine, isOff, offRead],
  );
  const hidden = useMemo(() => mine.filter(isOff).map((one) => one.agent.id), [mine, isOff]);
  // One that is back on the list because something was said in it is no longer kept as taken off.
  const back = Object.entries(off).some(([agent, at]) => saidSince(agent, at));
  useEffect(() => {
    if (back) change((was) => without(was, saidSince));
  }, [back, change, saidSince]);
  const hide = useCallback<AllChats["hide"]>(
    (agent) => {
      if (pins.includes(agent)) pin(agent, false);
      const now = new Date().toISOString();
      const said = mine.find((one) => one.agent.id === agent)?.at;
      change((was) => ({
        // An agent that is gone is no longer kept.
        ...without(was, (one) => loaded && !byId.has(one)),
        // No earlier than its last words, whatever this clock says.
        [agent]: said && later(said, now) ? said : now,
      }));
    },
    [pins, pin, mine, loaded, byId, change],
  );
  const opened = useCallback<AllChats["opened"]>(
    (agent) => change((was) => without(was, (one) => one === agent)),
    [change],
  );
  const value = useMemo(
    () => ({ chats, others, listed: listed && offRead, read, pins, pin, hidden, hide, opened }),
    [chats, others, listed, offRead, read, pins, pin, hidden, hide, opened],
  );
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

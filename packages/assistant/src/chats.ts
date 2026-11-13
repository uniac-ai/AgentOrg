/**
 * An agent's conversations: one with each party that talks to it, found by who calls, each with
 * its entry in the store and the looper's thread it is. A conversation is made by its first
 * message. The entries are read when a conversation is first asked for, all of them, and then
 * stay in memory.
 */
import {
  type ChatMessage,
  Conversation,
  type chat,
  type kv,
  LATEST_TEXT_MAX,
} from "@agentorg/interfaces";
import {
  type Call,
  createLooper,
  Entry,
  forget,
  type Store as LooperStore,
  type Model,
  Refusal,
  type Tool,
  textOf,
} from "@agentorg/looper";
import { type Log, Refused, type Slot } from "@agentorg/sdk";
import { z } from "zod";
import { filesOf, head, relayed } from "./tools.js";

type Store = Slot<typeof kv>["call"];
type Listed = z.input<typeof Conversation>;
type Message = z.input<typeof ChatMessage>;
type Input<M extends keyof (typeof chat)["methods"]> = z.output<
  (typeof chat)["methods"][M]["input"]
>;
type Emitted<E extends keyof (typeof chat)["events"]> = z.input<
  (typeof chat)["events"][E]["payload"]
>;

/**
 * The looper's keys in the agent's store. A conversation's entry names its thread, and a thread's
 * record is where a chat's has always been, under `chat/<thread>/`; anything else the looper
 * keeps is under `loop/`. A list is of one or of the other, never across both. What the store refuses, the looper
 * is told as its own refusal.
 */
const THREADS = "thread/";
const CHATS = "chat/";
const REST = "loop/";
const toStore = (key: string) =>
  key.startsWith(THREADS) ? CHATS + key.slice(THREADS.length) : REST + key;
const fromStore = (key: string) =>
  key.startsWith(CHATS) ? THREADS + key.slice(CHATS.length) : key.slice(REST.length);
function forLooper(store: Store): LooperStore {
  return {
    get: ({ key }) => relayed(store.get({ key: toStore(key) })),
    set: ({ key, value }) => relayed(store.set({ key: toStore(key), value })),
    delete: ({ key }) => relayed(store.delete({ key: toStore(key) })),
    async list({ prefix = "", after, limit }) {
      const page = await relayed(
        store.list({
          prefix: toStore(prefix),
          ...(after === undefined ? {} : { after: toStore(after) }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );
      return {
        keys: page.keys.map(fromStore),
        next: page.next === null ? null : fromStore(page.next),
      };
    },
  };
}
/**
 * The looper as the conversations call it: every call into it passes here. What the looper
 * refuses is refused as the conversation's, and what the store refused comes back as the store's
 * own error.
 */
function forChats<T extends object>(looper: T): T {
  const outward = (error: unknown): never => {
    if (!(error instanceof Refusal)) throw error;
    throw error.cause ?? new Refused(error.code, error.message);
  };
  return new Proxy(looper, {
    get(target, name, receiver) {
      const member: unknown = Reflect.get(target, name, receiver);
      if (typeof member !== "function") return member;
      return (...given: unknown[]) => {
        try {
          const result: unknown = member.apply(target, given);
          return result instanceof Promise ? result.catch(outward) : result;
        } catch (error) {
          return outward(error);
        }
      };
    },
  });
}
/** Where the one conversation an agent had before it had chats was kept. */
const LEGACY = "msg/";
/** Stored values read at once when the entries, or that conversation, are first loaded. */
const READS = 16;
/** The chat that the one conversation an agent had before it had chats becomes. */
const FIRST = "first";
const PAGE = 50;
/** The person, as the Hub names them when they call. */
const PERSON = "person";
/** A conversation's entry is kept under `conversations/<with>`. */
const CONVERSATIONS = "conversations/";
const entryKey = (party: string) => CONVERSATIONS + encodeURIComponent(party);
/** Where a chat's entry was kept before an agent had one conversation with each party. */
const CHATS_BEFORE = "chats/";
/**
 * The first line management wrote into a message an agent sent another through it, as control's
 * `agent_send` wrote it before an agent sent its own: a chat that began so was that agent's.
 */
const FROM_AGENT = /^An agent, ".*", says:\n/;

/** What is kept of a conversation beside its record. */
const Stored = z.object({
  /** The looper's thread it is. */
  thread: z.string(),
  at: z.string(),
  /** Its place in the list: the highest is the conversation a message was last sent in. */
  order: z.number(),
  latest: Conversation.shape.latest,
  /** Why a message in it got no answer, until its next reply. */
  problem: z.object({ code: z.string(), message: z.string() }).optional(),
});
type Stored = z.output<typeof Stored>;
/** What was kept of a chat, before. */
const ChatBefore = z.object({
  at: z.string(),
  order: z.number(),
  problem: z.object({ code: z.string(), message: z.string() }).optional(),
});

interface Held {
  /** Who it is with. */
  with: string;
  stored: Stored;
}

/** Every key under `prefix`, in order. */
async function keysUnder(store: Store, prefix: string) {
  const keys: string[] = [];
  let after: string | undefined;
  do {
    const page = await store.list({ prefix, limit: 1000, ...(after ? { after } : {}) });
    keys.push(...page.keys);
    after = page.next ?? undefined;
  } while (after);
  return keys;
}
/** The looper's key of a thread's record, in the agent's store. */
const recordKey = (thread: string) => `${CHATS}${encodeURIComponent(thread)}/`;

export function createChats(options: {
  store: Store;
  /**
   * The agent's model, and what a request to it says and offers, as its looper asks for them;
   * `voice` is the agent's own instructions, which its main loop speaks as.
   */
  model: Model;
  request(): Promise<{
    instructions: string;
    tools: Tool[];
    model?: string | undefined;
    voice?: string | undefined;
  }>;
  /** Whether the agent is stopped when its conversations are first held. */
  stopped: boolean;
  /** A stopped turn: end what its calls left running (see the looper's `stopGroup`). */
  stopGroup?(group: string): Promise<unknown>;
  /** Each event of a conversation goes to its party, `to`, and to the person; a status to all. */
  emit: {
    message(message: Emitted<"message">, to: string): void;
    delta(delta: Emitted<"delta">, to: string): void;
    status(status: Emitted<"status">): void;
    chat(entry: Listed, to: string): void;
    /** What a piece of the agent's work did changed. */
    worked(): void;
  };
  log: Log;
}) {
  const { store, emit, log } = options;
  /** The highest place in the list given so far. */
  let top = 0;
  /** Entries being written, one after another, so the latest written is the latest said. */
  let writing: Promise<unknown> = Promise.resolve();
  /** The conversations, by whom they are with and by their thread, once their entries are read. */
  const conversations = new Map<string, Held>();
  const byThread = new Map<string, Held>();
  let loaded: Promise<Map<string, Held>> | undefined;
  /** Whether the agent is working, as its looper last said. */
  let working = false;
  const stateNow = () => ({ state: working ? ("working" as const) : ("idle" as const) });
  /** `inner`, each call made once the conversations are read: the looper reads nothing before. */
  const afterLoad = (inner: LooperStore): LooperStore => {
    const after =
      <A, R>(call: (input: A) => Promise<R>) =>
      async (input: A) => {
        await load();
        return call(input);
      };
    return {
      get: after(inner.get),
      set: after(inner.set),
      delete: after(inner.delete),
      list: after(inner.list),
    };
  };
  /** A conversation's event, to its party and to the person. */
  const tell = (held: Held, each: (to: string) => void) => {
    each(held.with);
    if (held.with !== PERSON) each(PERSON);
  };
  /** The agent's loops: a conversation is the looper's thread its entry names. */
  const looper = forChats(
    createLooper({
      store: afterLoad(forLooper(store)),
      model: options.model,
      request: options.request,
      out: {
        message(thread, message) {
          const held = byThread.get(thread);
          if (!held) return;
          sent(held, message);
          tell(held, (to) => emit.message({ ...message, with: held.with }, to));
        },
        delta(thread, id, text) {
          const held = byThread.get(thread);
          if (held) tell(held, (to) => emit.delta({ with: held.with, id, text }, to));
        },
        working(on) {
          working = on;
          emit.status(stateNow());
        },
        // A message in the conversation got no answer: it is told why. The looper says this
        // before it says the agent is idle.
        failed(thread, { code, message }) {
          const held = byThread.get(thread);
          if (!held) return;
          held.stored.problem = { code: head(code, 128), message: head(message, 2000) };
          told(held);
        },
        worked: () => emit.worked(),
      },
      stopped: options.stopped,
      ...(options.stopGroup ? { stopGroup: options.stopGroup } : {}),
      // Who its worker is told a message is from: anyone but the person, by their id.
      speaker: (thread) => {
        const party = byThread.get(thread)?.with;
        return party === PERSON ? undefined : (party ?? "a party it doesn't know");
      },
      files: filesOf,
      log,
    }),
  );

  const entryOf = ({ with: party, stored }: Held): Listed => ({
    with: party,
    at: stored.at,
    ...(stored.latest ? { latest: stored.latest } : {}),
    ...(stored.problem ? { problem: stored.problem } : {}),
  });
  /** Write a conversation's entry as it now is, after any write before it. */
  const save = (held: Held) => {
    const value = { ...held.stored };
    const written = writing.then(() => store.set({ key: entryKey(held.with), value }));
    writing = written.catch(() => {});
    return written;
  };
  /** Say a conversation's entry as it now is; its write follows. */
  const told = (held: Held) => {
    // What it tells is already so: an entry that can't be written is behind until the next.
    save(held).catch((error: unknown) =>
      log.error("A conversation's entry couldn't be stored.", {
        with: held.with,
        error: String(error),
      }),
    );
    tell(held, (to) => emit.chat(entryOf(held), to));
  };
  /**
   * A message moves its conversation to the front of the list and is its latest; a reply also
   * ends its problem.
   */
  const sent = (held: Held, message: Message) => {
    held.stored.order = ++top;
    held.stored.latest = {
      id: message.id,
      at: message.at,
      role: message.role,
      text: head(message.text, LATEST_TEXT_MAX),
    };
    if (message.role === "assistant") delete held.stored.problem;
    told(held);
  };
  const hold = (party: string, stored: Stored) => {
    const held = { with: party, stored };
    conversations.set(party, held);
    byThread.set(stored.thread, held);
    top = Math.max(top, stored.order);
    return held;
  };

  /**
   * The conversation an agent had before it had chats becomes its first chat. Its entry is written
   * before any message moves, from all of them, so a move cut short goes on from where it stopped
   * with the entry it began with.
   */
  const adopt = async () => {
    const keys = await keysUnder(store, LEGACY);
    if (keys.length === 0) return;
    const values: unknown[] = [];
    for (let at = 0; at < keys.length; at += READS)
      values.push(
        ...(await Promise.all(keys.slice(at, at + READS).map((key) => store.get({ key })))).map(
          (read) => read.value,
        ),
      );
    if (!ChatBefore.safeParse((await store.get({ key: CHATS_BEFORE + FIRST })).value).success) {
      const read = values.flatMap((value) => {
        const entry = Entry.safeParse(value);
        return entry.success ? [entry.data] : [];
      });
      await store.set({
        key: CHATS_BEFORE + FIRST,
        value: { at: read[0]?.at ?? new Date().toISOString(), order: 0 },
      });
    }
    for (const [i, key] of keys.entries()) {
      if (values[i] !== undefined)
        await store.set({
          key: `${CHATS}${FIRST}/${key}`,
          value: values[i] as z.core.util.JSONType,
        });
      await store.delete({ key });
    }
    log.info("The conversation it had is now its first chat.", { messages: keys.length });
  };
  /** What a thread keeps: its first user message, and the newest of all, as stored. */
  const endsOf = async (thread: string) => {
    const keys = await keysUnder(store, recordKey(thread));
    const read = async (key: string) => {
      const entry = Entry.safeParse((await store.get({ key })).value);
      return entry.success ? entry.data : undefined;
    };
    let opening: Entry | undefined;
    for (const key of keys) {
      opening = await read(key);
      if (opening?.role === "user") break;
      opening = undefined;
    }
    let newest: Entry | undefined;
    for (const key of [...keys].reverse()) {
      newest = await read(key);
      if (newest) break;
    }
    return { opening, newest };
  };
  /**
   * The chats an agent had before it had one conversation with each party: of the person's, and of
   * any conversation with the person kept already, the one whose newest message is the newest
   * becomes their conversation. Every other chat is deleted, those another agent started too, with
   * the pieces of work that followed only those. The conversation is written before anything is
   * deleted, so an upgrade cut short goes on from it; one run again after a rollback weighs the
   * chats made since against it.
   */
  const upgrade = async () => {
    const keys = await keysUnder(store, CHATS_BEFORE);
    if (keys.length === 0) return;
    const ids = keys.map((key) => key.slice(CHATS_BEFORE.length));
    const already = Stored.safeParse((await store.get({ key: entryKey(PERSON) })).value);
    const candidates: { stored: Stored; newest: string }[] = [];
    if (already.success) {
      const { newest } = await endsOf(already.data.thread);
      candidates.push({ stored: already.data, newest: newest?.at ?? already.data.at });
    }
    for (const [i, id] of ids.entries()) {
      const before = ChatBefore.safeParse((await store.get({ key: keys[i] as string })).value);
      if (!before.success) continue;
      const { opening, newest } = await endsOf(id);
      // A chat with no message of the person's, or one an agent began, is not theirs: but the
      // conversation the agent had before it had chats was theirs.
      if (id !== FIRST && (!opening || FROM_AGENT.test(textOf(opening)))) continue;
      const shown = newest && newest.role !== "tool" && !newest.unsent ? newest : undefined;
      candidates.push({
        stored: {
          thread: id,
          at: before.data.at,
          order: before.data.order,
          ...(shown
            ? {
                latest: {
                  id: shown.id,
                  at: shown.at,
                  role: shown.role as "user" | "assistant",
                  text: head(textOf(shown), LATEST_TEXT_MAX),
                },
              }
            : {}),
          ...(before.data.problem ? { problem: before.data.problem } : {}),
        },
        newest: newest?.at ?? before.data.at,
      });
    }
    const kept = candidates.sort((a, b) => b.newest.localeCompare(a.newest))[0]?.stored;
    if (kept) await store.set({ key: entryKey(PERSON), value: kept });
    const gone = [
      ...ids,
      ...(already.success && already.data.thread !== kept?.thread ? [already.data.thread] : []),
    ].filter((thread) => thread !== kept?.thread);
    const { works } = await forget(forLooper(store), gone);
    for (const id of ids) await store.delete({ key: CHATS_BEFORE + id });
    log.info(
      `One conversation per party: kept ${kept ? 1 : 0}, deleted ${gone.length} chats and ${works} pieces of work.`,
    );
  };
  const load = () => {
    if (loaded) return loaded;
    const attempt = (async () => {
      await adopt();
      await upgrade();
      const keys = await keysUnder(store, CONVERSATIONS);
      for (let at = 0; at < keys.length; at += READS) {
        const some = keys.slice(at, at + READS);
        const values = await Promise.all(some.map((key) => store.get({ key })));
        some.forEach((key, i) => {
          const stored = Stored.safeParse(values[i]?.value);
          if (!stored.success) {
            log.warn("A conversation's entry didn't read back; it is left out.", { key });
            return;
          }
          hold(decodeURIComponent(key.slice(CONVERSATIONS.length)), stored.data);
        });
      }
      return conversations;
    })();
    loaded = attempt;
    attempt.catch(() => {
      if (loaded === attempt) loaded = undefined;
    });
    return attempt;
  };
  /** A party's first message while it is being said: its others wait for it, one at a time. */
  const beginning = new Map<string, Promise<unknown>>();
  return {
    /**
     * Say a message in the caller's conversation, which it begins if there is none. A message in a
     * conversation no work follows is put to the agent's main loop. When that answers it itself,
     * the conversation stays no work's, and its next message is put to the main loop too. When it
     * gives it to new work or to work there is, that work follows the conversation from then on,
     * beside any that already does. A message there goes to each piece of work in a turn, at its
     * next model request, or, with none in a turn, to the one last active, which starts a turn.
     */
    async send(
      { text = "", images }: Input<"send">,
      caller: string,
    ): Promise<{ messageId: string }> {
      const all = await load();
      for (let first = beginning.get(caller); first; first = beginning.get(caller))
        await first.catch(() => {});
      // Nothing waits from here to its first message being set: one first message at a time.
      const found = all.get(caller);
      if (found) return looper.send(found.stored.thread, text, images);
      const first = (async () => {
        const stored: Stored = {
          thread: crypto.randomUUID(),
          at: new Date().toISOString(),
          order: ++top,
        };
        // Its entry first: a record with no entry would be a conversation nobody can find.
        await store.set({ key: entryKey(caller), value: stored });
        const held = hold(caller, stored);
        try {
          return await looper.send(stored.thread, text, images);
        } catch (error) {
          // One its first message didn't begin is no conversation.
          const said = await looper.page(stored.thread, undefined, 1).catch(() => undefined);
          if (said?.messages.length === 0) {
            conversations.delete(caller);
            byThread.delete(held.stored.thread);
            await store.delete({ key: entryKey(caller) }).catch(() => {});
          }
          throw error;
        }
      })();
      beginning.set(caller, first);
      try {
        return await first;
      } finally {
        if (beginning.get(caller) === first) beginning.delete(caller);
      }
    },
    /** The caller's conversation's messages; the person may read anyone's. */
    async history({ with: party, before, limit }: Input<"history">, caller: string) {
      const of = party ?? caller;
      if (of !== caller && caller !== PERSON)
        throw new Refused("forbidden", "Only the person reads another's conversation.");
      const held = (await load()).get(of);
      if (!held) return { messages: [], more: false };
      return looper.page(held.stored.thread, before, limit ?? PAGE);
    },
    /** What the agent is doing now. */
    state: stateNow,
    /**
     * The conversations after `before` in the list, the one a message was last sent in first: the
     * person's every one, anyone else's only their own.
     */
    async list({ before, limit = PAGE }: Input<"list">, caller: string) {
      const found = await load();
      const mark = before === undefined ? undefined : found.get(before);
      if (before !== undefined && !mark) return { conversations: [], more: false };
      const rest = [...found.values()]
        .filter(
          (held) =>
            (caller === PERSON || held.with === caller) &&
            (!mark || held.stored.order < mark.stored.order),
        )
        .sort((a, b) => b.stored.order - a.stored.order);
      return { conversations: rest.slice(0, limit).map(entryOf), more: rest.length > limit };
    },
    /**
     * Stop the agent: its turns are cut, and none starts until it is started. A call already
     * running finishes first, so this answers when nothing more will be written. Its
     * conversations stay as they are, to be read.
     */
    stop: () => looper.stop(),
    start: () => looper.start(),
    /** Go on with what was cut off when the agent last ran, each once: turns, and messages waiting. */
    async resume() {
      // The conversations first: an upgrade is done before the looper reads, and what a turn says
      // moves its conversation in the list.
      await load();
      await looper.resume();
    },
    /**
     * Close for good: its turns are cut, and none starts after. They stay marked, as do messages
     * no work has taken, so the engine that opens this store next goes on with them.
     */
    close: () => looper.close(),
    /** Settles when every piece of work's latest turn has written all it will. */
    async settled() {
      await loaded?.catch(() => undefined);
      await looper.settled();
      await writing;
    },
    /** Streamed text of the model request running now. */
    delta(requestId: string, text: string, call?: Call) {
      looper.delta(requestId, text, call);
    },
    /**
     * The agent's pieces of work, most recently active first, those last active before `before`
     * when it is given, each with its latest entries.
     */
    async works(limit: number, entries: number, before?: string) {
      await load();
      return looper.works(limit, entries, before);
    },
    /** One piece of work's entries, before the entry `before`. */
    async entries(work: string, before: string | undefined, limit: number) {
      await load();
      return looper.entries(work, before, limit);
    },
  };
}

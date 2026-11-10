/**
 * An agent's chats: each one's entry and record in the store, its own loop, and the one turn this
 * engine has them share. A chat is made by the message that starts it and is never deleted. The
 * entries are read when a chat is first asked for, all of them, and a chat's record when the chat
 * is first used; both then stay in memory.
 */
import {
  CHAT_TITLE_MAX,
  type ChatEntry,
  type ChatMessage,
  type chat,
  type kv,
} from "@agentorg/interfaces";
import { type Log, Refused, type Slot } from "@agentorg/sdk";
import { z } from "zod";
import type { Chat, createAgent } from "./agent.js";
import { createHistory, Entry, type History, head, MESSAGES, READS, textOf } from "./history.js";

type Store = Slot<typeof kv>["call"];
type Agent = ReturnType<typeof createAgent>;
type Listed = z.input<typeof ChatEntry>;
type Message = z.input<typeof ChatMessage>;
type Input<M extends keyof (typeof chat)["methods"]> = z.output<
  (typeof chat)["methods"][M]["input"]
>;
type Emitted<E extends keyof (typeof chat)["events"]> = z.input<
  (typeof chat)["events"][E]["payload"]
>;

/** A chat's entry is kept under `chats/<id>`, and its record under `chat/<id>/`. */
const ENTRIES = "chats/";
const recordOf = (id: string) => `chat/${id}/`;
/** The chat that the one conversation an agent had before it had chats becomes. */
const FIRST = "first";
const PAGE = 50;

/** What is kept of a chat beside its record. */
const Stored = z.object({
  title: z.string(),
  at: z.string(),
  /** Its place in the list: the highest is the chat a message was last sent in. */
  order: z.number(),
  latest: z.object({ id: z.string(), at: z.string() }).optional(),
  archived: z.boolean(),
});
type Stored = z.output<typeof Stored>;

interface Held {
  id: string;
  stored: Stored;
  history: History;
  agent: Agent;
}

/** A title from a message: its first line with anything in it, on one line. */
const titleOf = (text: string) =>
  head(
    (text.split("\n").find((line) => /\S/.test(line)) ?? "").replace(/\s+/g, " ").trim(),
    CHAT_TITLE_MAX,
  );

/** The store's keys under `prefix`, as a store of its own. */
function under(store: Store, prefix: string): Store {
  return {
    get: ({ key }) => store.get({ key: prefix + key }),
    set: ({ key, value }) => store.set({ key: prefix + key, value }),
    delete: ({ key }) => store.delete({ key: prefix + key }),
    async list({ prefix: inner = "", after, limit }) {
      const page = await store.list({
        prefix: prefix + inner,
        ...(after === undefined ? {} : { after: prefix + after }),
        ...(limit === undefined ? {} : { limit }),
      });
      return {
        keys: page.keys.map((key) => key.slice(prefix.length)),
        next: page.next === null ? null : page.next.slice(prefix.length),
      };
    },
  };
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

export function createChats(options: {
  store: Store;
  /** A chat's loop, on its record, saying what it does through `chat`. */
  agent(history: History, chat: Chat): Agent;
  emit: {
    message(message: Emitted<"message">): void;
    delta(delta: Emitted<"delta">): void;
    status(status: Emitted<"status">): void;
    chat(entry: Listed): void;
  };
  log: Log;
}) {
  const { store, emit, log } = options;
  /** The chat that has the turn: this engine runs one at a time, whichever chat it is in. */
  let working: { held: Held } | undefined;
  /** The chat that last had it: a turn stopped there may have a call still running. */
  let last: Held | undefined;
  /** Set when the engine stops: no turn starts after. */
  let stopped = false;
  /** The highest place in the list given so far. */
  let top = 0;
  /** Entries being written, one after another, so the latest written is the latest said. */
  let writing: Promise<unknown> = Promise.resolve();
  let loaded: Promise<Map<string, Held>> | undefined;

  const entryOf = ({ id, stored, agent }: Held): Listed => ({
    id,
    title: stored.title,
    at: stored.at,
    ...(stored.latest ? { latest: stored.latest } : {}),
    state: agent.state().state,
    archived: stored.archived,
  });
  /** Write a chat's entry as it now is, after any write before it. */
  const save = (held: Held) => {
    const value = { ...held.stored };
    const written = writing.then(() => store.set({ key: ENTRIES + held.id, value }));
    writing = written.catch(() => {});
    return written;
  };
  /** A message sent in a chat moves it to the front of the list; a reply is what is new in it. */
  const sent = (held: Held, message: Message) => {
    if (message.role === "tool") return;
    held.stored.order = ++top;
    if (message.role === "assistant") held.stored.latest = { id: message.id, at: message.at };
    // The message is recorded already: an entry that can't be written is behind until the next.
    save(held).catch((error: unknown) =>
      log.error("A chat's entry couldn't be stored.", { chat: held.id, error: String(error) }),
    );
    emit.chat(entryOf(held));
  };
  /** Change what a chat is called or where it is listed: a change the store refuses isn't made. */
  const keep = async <K extends "title" | "archived">(held: Held, key: K, value: Stored[K]) => {
    const was = held.stored[key];
    held.stored[key] = value;
    try {
      await save(held);
    } catch (error) {
      held.stored[key] = was;
      throw error;
    }
    emit.chat(entryOf(held));
  };
  const hold = (id: string, stored: Stored): Held => {
    const history = createHistory(under(store, recordOf(id)), log);
    const held: Held = {
      id,
      stored,
      history,
      agent: options.agent(history, {
        message(message) {
          sent(held, message);
          emit.message({ ...message, chat: id });
        },
        delta: (message, text) => emit.delta({ chat: id, id: message, text }),
        status(status) {
          // The turn is given back before anyone hears it is over: the next may start at once.
          if (working?.held === held && (status.state === "idle" || status.state === "error"))
            working = undefined;
          emit.status({ ...status, chat: id });
        },
      }),
    };
    return held;
  };

  /**
   * The conversation an agent had before it had chats becomes its first chat. Its entry is written
   * before any message moves, from all of them, so a move cut short goes on from where it stopped
   * with the entry it began with.
   */
  const adopt = async () => {
    const keys = await keysUnder(store, MESSAGES);
    if (keys.length === 0) return;
    const values: unknown[] = [];
    for (let at = 0; at < keys.length; at += READS)
      values.push(
        ...(await Promise.all(keys.slice(at, at + READS).map((key) => store.get({ key })))).map(
          (read) => read.value,
        ),
      );
    if (!Stored.safeParse((await store.get({ key: ENTRIES + FIRST })).value).success) {
      const read = values.flatMap((value) => {
        const entry = Entry.safeParse(value);
        return entry.success ? [entry.data] : [];
      });
      const reply = read.findLast((entry) => entry.role === "assistant");
      const opening = read.find((entry) => entry.role === "user") ?? read[0];
      const stored: Stored = {
        title: opening ? titleOf(textOf(opening)) : "",
        at: read[0]?.at ?? new Date().toISOString(),
        // Behind every chat started since.
        order: 0,
        ...(reply ? { latest: { id: reply.id, at: reply.at } } : {}),
        archived: false,
      };
      await store.set({ key: ENTRIES + FIRST, value: stored });
    }
    const record = under(store, recordOf(FIRST));
    for (const [i, key] of keys.entries()) {
      if (values[i] !== undefined)
        await record.set({ key, value: values[i] as z.core.util.JSONType });
      await store.delete({ key });
    }
    log.info("The conversation it had is now its first chat.", { messages: keys.length });
  };
  const load = () => {
    if (loaded) return loaded;
    const attempt = (async () => {
      await adopt();
      const found = new Map<string, Held>();
      const keys = await keysUnder(store, ENTRIES);
      for (let at = 0; at < keys.length; at += READS) {
        const some = keys.slice(at, at + READS);
        const values = await Promise.all(some.map((key) => store.get({ key })));
        some.forEach((key, i) => {
          const stored = Stored.safeParse(values[i]?.value);
          const id = key.slice(ENTRIES.length);
          if (!stored.success) {
            log.warn("A chat's entry didn't read back; the chat is left out.", { key });
            return;
          }
          found.set(id, hold(id, stored.data));
          top = Math.max(top, stored.data.order);
        });
      }
      return found;
    })();
    loaded = attempt;
    attempt.catch(() => {
      if (loaded === attempt) loaded = undefined;
    });
    return attempt;
  };
  const heldOf = async (id: string) => {
    const held = (await load()).get(id);
    if (!held) throw new Refused("unknown", "This agent has no such chat.");
    return held;
  };
  /**
   * Start a turn in a chat, or refuse while any chat has the turn. The turn is given back if it
   * doesn't start; once it has, its status gives it back.
   */
  const turn = async <T>(held: Held, start: () => Promise<T>) => {
    if (stopped) throw new Refused("unavailable", "This agent is stopping.");
    if (working)
      throw new Refused(
        "busy",
        working.held === held
          ? "A turn is running. Wait for it, or cancel it."
          : "It is working in another chat. Wait for it, or stop it there.",
      );
    const mine = { held };
    working = mine;
    try {
      // A turn stopped in another chat may have a call still running: it ends before this starts.
      if (last !== held) await last?.agent.drained();
      last = held;
      return await start();
    } catch (error) {
      if (working === mine) working = undefined;
      throw error;
    }
  };

  return {
    /** Start a turn in a chat, or in a new chat this message starts. */
    async send({ chat, text }: Input<"send">) {
      if (chat !== undefined) {
        const held = await heldOf(chat);
        const { messageId } = await turn(held, () => held.agent.send(text));
        return { chat, messageId };
      }
      const found = await load();
      const held = hold(crypto.randomUUID(), {
        title: titleOf(text),
        at: new Date().toISOString(),
        order: ++top,
        archived: false,
      });
      return turn(held, async () => {
        try {
          // Its entry first: a record with no entry would be a chat nobody can find.
          await store.set({ key: ENTRIES + held.id, value: held.stored });
          found.set(held.id, held);
          if (stopped) throw new Refused("unavailable", "This agent is stopping.");
          const { messageId } = await held.agent.send(text);
          return { chat: held.id, messageId };
        } catch (error) {
          found.delete(held.id);
          await store.delete({ key: ENTRIES + held.id }).catch(() => {});
          throw error;
        }
      });
    },
    history: async ({ chat, before, limit }: Input<"history">) =>
      (await heldOf(chat)).history.page(before, limit ?? PAGE),
    async cancel({ chat }: Input<"cancel">) {
      await (await heldOf(chat)).agent.cancel();
      return {};
    },
    state: async ({ chat }: Input<"state">) => (await heldOf(chat)).agent.state(),
    async retry({ chat }: Input<"retry">) {
      const held = await heldOf(chat);
      return turn(held, () => held.agent.retry());
    },
    /**
     * The chats after `before` in the list, the one a message was last sent in first. `before`
     * holds its place whether it is archived or not, so a page never leaves out a chat that hasn't
     * moved since the page before it.
     */
    async list({ archived = false, before, limit = PAGE }: Input<"list">) {
      const found = await load();
      const mark = before === undefined ? undefined : found.get(before);
      if (before !== undefined && !mark) return { chats: [], more: false };
      const rest = [...found.values()]
        .filter(
          ({ stored }) =>
            stored.archived === archived && (!mark || stored.order < mark.stored.order),
        )
        .sort((a, b) => b.stored.order - a.stored.order);
      return { chats: rest.slice(0, limit).map(entryOf), more: rest.length > limit };
    },
    async rename({ chat, title }: Input<"rename">) {
      await keep(await heldOf(chat), "title", titleOf(title));
      return {};
    },
    async archive({ chat, archived }: Input<"archive">) {
      await keep(await heldOf(chat), "archived", archived);
      return {};
    },
    /** Stop for good: the turn in progress is cut, and none starts after. */
    async stop() {
      stopped = true;
      await working?.held.agent.cancel();
    },
    /** Settles when every chat's latest turn has written all it will. */
    async settled() {
      const found = await loaded?.catch(() => undefined);
      await Promise.all([...(found?.values() ?? [])].map((held) => held.agent.settled()));
      await writing;
    },
    /** Streamed text of the model request running now. */
    delta(requestId: string, text: string) {
      working?.held.agent.delta(requestId, text);
    },
  };
}

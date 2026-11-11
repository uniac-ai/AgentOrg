/**
 * What a loop runs on, kept in a store. A thread keeps its messages, one key each: the items a
 * model reads for it, and for a tool message the line a person sees. A thread is read once, then
 * kept in memory, and its oldest messages are deleted past a retention cap. A piece of work reads
 * its context from the threads it follows: each message is kept once, in the thread where it is
 * shown, and says which work it belongs to when that isn't its thread's own.
 */
import { z } from "zod";
import { Item, type Json, type Log, type Shown, type Store } from "./types.js";

/** A message as the record keeps it. */
export const Entry = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  /** What the person sees, for a tool message; the others show their message items. */
  text: z.string().optional(),
  at: z.string(),
  items: z.array(Item),
  /** For a tool message whose call ran: how it ended. */
  state: z.enum(["done", "refused"]).optional(),
  /** For a user message said while a turn was running: it is part of that turn. */
  joined: z.literal(true).optional(),
  /**
   * For what came of a model request that had read its work up to this place, when a user message
   * was said after that: the model reads it ahead of that message, which it doesn't answer.
   */
  ahead: z.number().optional(),
  /** The piece of work it belongs to, when that isn't its thread's own. */
  work: z.string().optional(),
  /**
   * Its place in its work's order, once that work follows more than one thread. Without it, its
   * place is its number in its thread.
   */
  place: z.number().optional(),
});
export type Entry = z.output<typeof Entry>;

/** Where a record's messages are kept in its store. */
export const MESSAGES = "msg/";
const keyOf = (seq: number) => `${MESSAGES}${String(seq).padStart(12, "0")}`;
const seqOf = (key: string) => Number(key.slice(MESSAGES.length)) || 0;
// The record's limits are fixed here for now, sized for a host that carries a model request, or a
// page of messages, in one piece of about a megabyte.
/** What the model is sent of the past: the newest exchanges up to this many bytes of JSON. */
export const INPUT_BUDGET = 400_000;
/** At most this many messages are kept, in at most this many bytes, oldest deleted first. */
export const KEEP = 2000;
export const KEEP_BYTES = 16 * 1024 * 1024;
/** A stored message's text, and a call's arguments, are cut to fit these, in bytes of JSON. */
const MAX_TEXT = 192 * 1024;
const MAX_ARGUMENTS = 16 * 1024;
/** A page of messages stays under this, so whatever carries it can do so in one piece. */
const PAGE_BUDGET = 512 * 1024;
const encoder = new TextEncoder();
const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const LEFT_OUT = "(Left out: the conversation was too large to send it.)";
const ARGUMENTS_LEFT_OUT = '{"left_out":"too large to keep"}';

/** The first `length` UTF-16 units of `text`, never ending inside a surrogate pair. */
export function head(text: string, length: number): string {
  const cut = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
/** `text`, cut so its JSON fits `max` bytes, saying so when it is cut. */
export function fitted(text: string, max: number): string {
  let kept = text;
  for (let bytes = size(kept); bytes > max; bytes = size(kept))
    kept = `${head(kept, Math.floor((kept.length * max) / bytes) - 16)}… (cut)`;
  return kept;
}
/** A message shows at most this much; the record keeps all of it. */
const MAX_SHOWN = 100_000;
/** What the person sees of a message. */
export const textOf = (entry: Entry) =>
  head(
    entry.text ??
      entry.items.flatMap((item) => (item.type === "message" ? [item.content] : [])).join(""),
    MAX_SHOWN,
  );
/** A call's arguments as they are kept and shown: past their cap, a note in their place. */
export const argumentsOf = (args: string) =>
  size(args) > MAX_ARGUMENTS ? ARGUMENTS_LEFT_OUT : args;

/**
 * A message as it is shown. A tool message whose call ran carries `tool`: the call's name, how it
 * ended, its arguments and its output.
 */
export function messageOf(entry: Entry): Shown {
  const message = { id: entry.id, role: entry.role, text: textOf(entry), at: entry.at };
  const call = entry.items.find((item) => item.type === "function_call");
  if (entry.role !== "tool" || !entry.state || !call) return message;
  const output = entry.items.find((item) => item.type === "function_call_output");
  return {
    ...message,
    tool: {
      name: head(call.name, 128),
      state: entry.state,
      input: head(call.arguments, MAX_SHOWN),
      ...(output ? { output: head(output.output, MAX_SHOWN) } : {}),
    },
  };
}

/** A message as it is stored: each text once, and nothing past its cap. */
const kept = (entry: Entry): Entry => ({
  ...entry,
  items: entry.items.map((item) => {
    if (item.type === "message") return { ...item, content: fitted(item.content, MAX_TEXT) };
    if (item.type === "function_call_output")
      return { ...item, output: fitted(item.output, MAX_TEXT) };
    return { ...item, arguments: argumentsOf(item.arguments) };
  }),
});

/** Stored values read at once when what is kept is first loaded. */
export const READS = 16;

/** A user message as it is kept when said. */
export const userEntry = (text: string) => ({
  role: "user" as const,
  items: [{ type: "message" as const, role: "user" as const, content: text }],
});

/** A message as a thread holds it. */
interface Kept {
  /** Its number in its thread. */
  seq: number;
  key: string;
  entry: Entry;
  bytes: number;
  /** Set while a user message is being written, or taken: the model is sent it once stored. */
  writing?: boolean;
}
interface Held {
  records: Kept[];
  last: number;
  bytes: number;
}

/** A thread's messages in a store, by their numbers. */
export function createThread(
  store: Store,
  log: Log,
  limits = { keep: KEEP, keepBytes: KEEP_BYTES },
) {
  let loaded: Promise<Held> | undefined;

  const load = () => {
    if (loaded) return loaded;
    const attempt = (async () => {
      const records: Kept[] = [];
      let last = 0;
      let bytes = 0;
      let after: string | undefined;
      do {
        const page = await store.list({
          prefix: MESSAGES,
          limit: 1000,
          ...(after ? { after } : {}),
        });
        // A few at a time, in order: a long record shouldn't hold up the first send one read at
        // a time, nor flood its store.
        for (let at = 0; at < page.keys.length; at += READS) {
          const keys = page.keys.slice(at, at + READS);
          const values = await Promise.all(keys.map((key) => store.get({ key })));
          keys.forEach((key, i) => {
            last = Math.max(last, seqOf(key));
            const parsed = Entry.safeParse(values[i]?.value);
            if (!parsed.success) {
              log.warn("A stored message didn't read back; it is left out.", { key });
              return;
            }
            const record = { seq: seqOf(key), key, entry: parsed.data, bytes: size(parsed.data) };
            records.push(record);
            bytes += record.bytes;
          });
        }
        after = page.next ?? undefined;
      } while (after);
      return { records, last, bytes };
    })();
    loaded = attempt;
    attempt.catch(() => {
      if (loaded === attempt) loaded = undefined;
    });
    return attempt;
  };

  return {
    /** What it holds, read once. */
    load,
    /**
     * Keep a message in a thread already read, at once, under `id` or its own number; `stored`
     * settles when it is written and the oldest past the cap are deleted. A tool message the store
     * refuses is still kept in memory, since its call has run; any other is taken out again.
     */
    push(held: Held, entry: Omit<Entry, "id" | "at">, id?: string) {
      const seq = ++held.last;
      const key = keyOf(seq);
      const record: Kept = {
        seq,
        key,
        entry: kept({
          id: id ?? key.slice(MESSAGES.length),
          at: new Date().toISOString(),
          ...entry,
        }),
        bytes: 0,
        writing: entry.role === "user",
      };
      record.bytes = size(record.entry);
      held.records.push(record);
      held.bytes += record.bytes;
      const stored = (async () => {
        try {
          await store.set({ key, value: record.entry as Json });
          record.writing = false;
        } catch (error) {
          if (entry.role !== "tool") {
            held.records.splice(held.records.indexOf(record), 1);
            held.bytes -= record.bytes;
            throw error;
          }
          log.error("A tool message couldn't be stored; it is kept until a restart.", {
            error: String(error),
          });
        }
        while (
          held.records.length > 1 &&
          (held.records.length > limits.keep || held.bytes > limits.keepBytes)
        ) {
          const oldest = held.records.shift() as Kept;
          held.bytes -= oldest.bytes;
          await store.delete({ key: oldest.key }).catch((error: unknown) =>
            log.warn("An old message couldn't be deleted.", {
              key: oldest.key,
              error: String(error),
            }),
          );
        }
      })();
      return { record, stored };
    },
    /**
     * Keep a message as `entry` from now on: at once in memory, then in the store. A write the
     * store refuses leaves it as it was.
     */
    async rewrite(held: Held, record: Kept, entry: Entry) {
      const was = { entry: record.entry, bytes: record.bytes };
      const swap = (to: typeof was) => {
        held.bytes += to.bytes - record.bytes;
        Object.assign(record, to);
      };
      swap({ entry, bytes: size(entry) });
      try {
        await store.set({ key: record.key, value: entry as Json });
      } catch (error) {
        swap(was);
        throw error;
      }
    },
    /** Messages before `before`, oldest first, as many as fit `limit` and `PAGE_BUDGET`. */
    async page(before: string | undefined, limit: number) {
      const { records } = await load();
      const end =
        before === undefined
          ? records.length
          : records.findIndex((record) => record.entry.id === before);
      const messages = [];
      let bytes = 0;
      let start = Math.max(end, 0);
      while (start > 0 && messages.length < limit) {
        const { entry } = records[start - 1] as Kept;
        const message = messageOf(entry);
        bytes += size(message);
        if (bytes > PAGE_BUDGET && messages.length > 0) break;
        messages.unshift(message);
        start--;
      }
      return { messages, more: start > 0 };
    },
  };
}
export type Thread = ReturnType<typeof createThread>;

/**
 * A piece of work's record: its messages across the threads it follows, in the order it took them.
 * Its id is the name of its own thread, whose messages are its unless they name another work; in
 * any other thread, the messages that name it are. A message's place is its number in its own
 * thread until the work follows a second thread, and a count kept with each message after. A
 * message waiting in a thread it follows, said before the work had the thread, names no work yet:
 * the work takes it, in the order it was said, before it keeps anything else there.
 */
export function createRecord(options: {
  id: string;
  /** The threads it follows now, its own first. */
  follows(): string[];
  thread(name: string): Thread;
}) {
  const { id } = options;
  const placeOf = (record: Kept) => record.entry.place ?? record.seq;
  const mine = (thread: string, record: Kept) =>
    record.entry.work === undefined ? thread === id : record.entry.work === id;

  /** Every thread it follows, read: what each holds, as it changes. */
  const load = async () => {
    const held = new Map<string, Held>();
    for (const name of options.follows()) held.set(name, await options.thread(name).load());
    return held;
  };
  type Placed = { thread: string; record: Kept };
  /**
   * Its own messages in the threads read, in order, as they stand now. Nothing waits between
   * this and what is decided from it.
   */
  const own = (held: Map<string, Held>): Placed[] => {
    const records = [...held].flatMap(([thread, { records }]) =>
      records.flatMap((record) => (mine(thread, record) ? [{ thread, record }] : [])),
    );
    // One thread's messages are in order already.
    if (held.size > 1) records.sort((a, b) => placeOf(a.record) - placeOf(b.record));
    return records;
  };
  /** The highest place among its messages. */
  const topOf = (records: Placed[]) => {
    const last = records.at(-1);
    return last ? placeOf(last.record) : 0;
  };
  /**
   * Take the messages waiting in `thread` as its own, after all it holds: at once in memory, and
   * `written` settles when each is stored, or rejects with one that isn't and stays waiting. Like
   * a message being written, the model is sent none of them until all are stored.
   */
  const take = (held: Map<string, Held>, thread: string, joined: boolean) => {
    const from = held.get(thread) as Held;
    const waiting = thread === id ? [] : from.records.filter(({ entry }) => !entry.work);
    let top = topOf(own(held));
    const writes = waiting.map((record) =>
      options.thread(thread).rewrite(from, record, {
        ...record.entry,
        work: id,
        place: ++top,
        ...(joined && record.entry.role === "user" ? { joined: true as const } : {}),
      }),
    );
    for (const record of waiting) record.writing = true;
    const written = Promise.allSettled(writes).then((all) => {
      for (const record of waiting) record.writing = false;
      const refused = all.find((one) => one.status === "rejected");
      if (refused) throw refused.reason;
    });
    return { taken: waiting.length, written };
  };
  /** Whether a user message of its follows the place `read`: one `stored` already, when asked. */
  const saidAfter = (records: Placed[], read: number, stored = false) =>
    records.some(
      ({ record }) =>
        record.entry.role === "user" && placeOf(record) > read && !(stored && record.writing),
    );
  /** The thread of its newest user message: where it answers. Its own, with none. */
  const whereOf = (records: Placed[]) =>
    records.findLast(({ record }) => record.entry.role === "user")?.thread ?? id;

  return {
    id,
    /**
     * Keep a message of its in `thread`, one of those it follows, after any waiting there. `read`
     * is given for what came of a model request that had read it up to that place: when a user
     * message was said since, it is kept as `ahead` of it.
     */
    async append(
      entry: Omit<Entry, "id" | "at" | "work" | "place" | "ahead">,
      at: { thread: string; id?: string; read?: number },
    ): Promise<{ entry: Entry; thread: string }> {
      const held = await load();
      const { thread } = at;
      // What waits there is taken and stored first, so this is never kept ahead of it: it joins
      // a turn if this does, or comes of one. If the store won't take it, nothing is kept.
      await take(held, thread, entry.joined === true || at.read !== undefined).written;
      // From here to the push nothing waits, so its place and what is ahead of it are decided
      // with the record as it stands.
      const records = own(held);
      const { record, stored } = options.thread(thread).push(
        held.get(thread) as Held,
        {
          ...entry,
          ...(thread === id ? {} : { work: id }),
          ...(held.size > 1 ? { place: topOf(records) + 1 } : {}),
          ...(at.read !== undefined && saidAfter(records, at.read) ? { ahead: at.read } : {}),
        },
        at.id,
      );
      await stored;
      return { entry: record.entry, thread };
    },
    /**
     * Take the messages waiting in `thread`, which it has come to follow, as its own: `joined`,
     * when a turn of its is running. It says how many there were to answer: in its own thread,
     * where nothing needs taking, those said since it last did anything.
     */
    async adopt(thread: string, joined: boolean): Promise<number> {
      const held = await load();
      const { taken, written } = take(held, thread, joined);
      await written;
      if (thread !== id) return taken;
      const records = own(held);
      const done = records.findLastIndex(({ record }) => record.entry.role !== "user");
      return records.length - 1 - done;
    },
    /** Whether it holds anything but what was said to it: it has had a turn that did something. */
    async begun(): Promise<boolean> {
      return own(await load()).some(({ record }) => record.entry.role !== "user");
    },
    /** Whether it has no message. */
    async empty(): Promise<boolean> {
      return own(await load()).length === 0;
    },
    /** The thread it answers in now. */
    async where(): Promise<string> {
      return whereOf(own(await load()));
    },
    /** Its first user message, for a title. */
    async opening(): Promise<string> {
      const first = own(await load()).find(({ record }) => record.entry.role === "user");
      return first ? textOf(first.record.entry) : "";
    },
    /**
     * The conversation to send: the newest exchanges (each from the user message that starts a turn
     * on) that fit the budget, and always the latest two, so "go on" after a long turn still has
     * that turn. When those two are over the budget, their oldest function arguments and outputs
     * are left out, each call still paired with an output. A message said during a turn comes after
     * whatever is `ahead` of it, so the model reads it as not yet answered. `read` is the place up
     * to which every user message was read, for `append` and `saidAfter`: one still being written
     * is not read yet. `thread` is where what comes of it is kept.
     */
    async input(): Promise<{ items: Item[]; read: number; thread: string }> {
      const records = own(await load());
      const last = topOf(records);
      const unwritten = records.find(({ record }) => record.writing);
      const read = unwritten ? placeOf(unwritten.record) - 1 : last;
      const exchanges: Item[][] = [];
      /** Said during a turn, and not yet put: what is ahead of them goes first. */
      const late: Kept[] = [];
      const put = (entry: Entry) => {
        if ((entry.role === "user" && !entry.joined) || exchanges.length === 0) exchanges.push([]);
        exchanges.at(-1)?.push(...entry.items);
      };
      /** Put the late messages placed up to `read`. */
      const putLate = (read: number) => {
        while (late[0] && placeOf(late[0]) <= read) put((late.shift() as Kept).entry);
      };
      for (const { record } of records) {
        // Nothing to send: a user message still being written, or a line with no items.
        if (record.writing || record.entry.items.length === 0) continue;
        if (record.entry.joined) {
          late.push(record);
          continue;
        }
        putLate(record.entry.ahead ?? last);
        put(record.entry);
      }
      putLate(last);
      let total = exchanges.reduce((sum, items) => sum + size(items), 0);
      while (exchanges.length > 2 && total > INPUT_BUDGET) total -= size(exchanges.shift());
      const items = exchanges.flat();
      for (let i = 0; i < items.length && total > INPUT_BUDGET; i++) {
        const item = items[i] as Item;
        if (item.type === "function_call_output" && item.output !== LEFT_OUT) {
          total -= size(item.output) - size(LEFT_OUT);
          items[i] = { ...item, output: LEFT_OUT };
        } else if (item.type === "function_call" && item.arguments !== ARGUMENTS_LEFT_OUT) {
          total -= size(item.arguments) - size(ARGUMENTS_LEFT_OUT);
          items[i] = { ...item, arguments: ARGUMENTS_LEFT_OUT };
        }
      }
      return { items, read, thread: whereOf(records.filter(({ record }) => !record.writing)) };
    },
    /** Whether a user message of its has been stored after the place `read`, which `input` gave. */
    async saidAfter(read: number): Promise<boolean> {
      return saidAfter(own(await load()), read, true);
    },
  };
}
export type LoopRecord = ReturnType<typeof createRecord>;

/**
 * What a loop runs on, kept in a store. A thread keeps its messages, one key each: the items a
 * model reads for it, and for a tool message the line a person sees. A thread is read once, then
 * kept in memory, and its oldest messages are deleted past a retention cap. A piece of work reads
 * its context from the threads it follows: each message is kept once, in the thread where it is
 * shown, and says which work it belongs to when that isn't its thread's own, or which pieces of
 * work when it was given to several.
 */
import { z } from "zod";
import { Item, type Json, type Log, type Shown, type Store } from "./types.js";

/**
 * One piece of work's hold on a user message that names the work it was given to: where it stands
 * in that work's order, once the work has taken it; whether it was said while a turn of that work
 * was running; and why that work handed it back, if it did. For new work the main loop starts
 * with it, the work's title, until that work has taken it: the whole of the decision is in this.
 */
const Given = z.object({
  work: z.string(),
  place: z.number().optional(),
  joined: z.literal(true).optional(),
  back: z.string().max(2000).optional(),
  title: z.string().optional(),
});
type Given = z.output<typeof Given>;

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
  /**
   * For a user message said while a turn was running, or while a stopped turn was still writing:
   * it is part of that turn. Also for what the main loop said in a thread, taken with such
   * messages or said as it stopped the turn: it stays in its place among them.
   */
  joined: z.literal(true).optional(),
  /**
   * For what came of a model request that had read its work up to this place, when a user message
   * was said after that, or the main loop said it stopped the turn: the model reads it ahead of
   * those, which it doesn't answer.
   */
  ahead: z.number().optional(),
  /** The piece of work it belongs to, when that isn't its thread's own. */
  work: z.string().optional(),
  /**
   * For what the main loop said itself, which no piece of work said: the number in its thread it
   * stands after, ahead of any said after that. For a reply that is the number it had read up to;
   * for what it said as it stopped a piece of work, all the thread held then.
   */
  main: z.number().optional(),
  /**
   * Its place in its work's order: one more than the highest that work held when it kept or
   * took this. Without it, its place is where it stands in its thread: its number, or for what
   * the main loop said, right after the number that names.
   */
  place: z.number().optional(),
  /**
   * The pieces of work it was given to, each with its own hold on it, in place of `work`,
   * `place` and `joined`: for a user message given to several, or handed back. One with no
   * `place` is still to be taken by that work. For what the main loop said in a thread that work
   * follows, none: it is no work's.
   */
  to: z.array(Given).optional(),
  /** For a tool message that is kept and sent to the model, and shown to nobody. */
  silent: z.literal(true).optional(),
  /**
   * For what the main loop said in answer to messages that came back from all they were given
   * to: their ids. Such a message is decided, and not put to the main loop again.
   */
  answers: z.array(z.string()).optional(),
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

/** What the main loop said, as it is kept: it stands after `after`, a number in its thread. */
const mainEntry = (text: string, after: number) => ({
  role: "assistant" as const,
  main: after,
  items: [{ type: "message" as const, role: "assistant" as const, content: text }],
});

/** A message as a thread holds it. */
interface Kept {
  /** Its number in its thread. */
  seq: number;
  key: string;
  entry: Entry;
  bytes: number;
  /**
   * Set while a user message is first being written: no model is sent it, and no work takes it,
   * until it is stored.
   */
  writing?: boolean;
  /** The pieces of work taking it now: each is sent it once its taking is stored. */
  taking?: Set<string>;
  /** The writes of it, one after another, each of the entry as it is when its turn comes. */
  writes?: Promise<unknown>;
}
interface Held {
  records: Kept[];
  last: number;
  bytes: number;
}

/**
 * Where a message stands in its thread: its number, but what the main loop said stands right
 * after the number it names, ahead of a message said while it answered.
 */
const orderOf = ({ seq, entry }: Kept) => (entry.main === undefined ? seq : entry.main + 0.5);

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

  /**
   * Keep a message in a thread already read, at once, under `id` or its own number; `stored`
   * settles when it is written and the oldest past the cap are deleted. A tool message the store
   * refuses is still kept in memory, since its call has run; any other is taken out again.
   */
  const push = (held: Held, entry: Omit<Entry, "id" | "at">, id?: string) => {
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
    const first = store.set({ key, value: record.entry as Json });
    record.writes = first.catch(() => {});
    const stored = (async () => {
      try {
        await first;
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
  };

  const change = (
    held: Held,
    record: Kept,
    apply: (entry: Entry) => Entry,
    revert: (entry: Entry) => Entry,
  ) => {
    const swap = (entry: Entry) => {
      const bytes = size(entry);
      held.bytes += bytes - record.bytes;
      record.entry = entry;
      record.bytes = bytes;
    };
    swap(apply(record.entry));
    return {
      store() {
        const written = (record.writes ?? Promise.resolve()).then(() =>
          store.set({ key: record.key, value: record.entry as Json }),
        );
        record.writes = written.catch(() => {});
        return written;
      },
      undo: () => swap(revert(record.entry)),
    };
  };

  const returnedOf = (held: Held) => {
    const answered = new Set(held.records.flatMap(({ entry }) => entry.answers ?? []));
    return held.records.flatMap(({ seq, entry }) =>
      entry.role === "user" &&
      !answered.has(entry.id) &&
      entry.to?.length &&
      entry.to.every((one) => one.back !== undefined)
        ? [
            {
              id: entry.id,
              seq,
              text: textOf(entry),
              by: entry.to.map(({ work, back }) => ({ work, why: back as string })),
            },
          ]
        : [],
    );
  };
  const offersOf = (held: Held) => {
    const waiting = new Map<string, string | undefined>();
    for (const { entry } of held.records)
      for (const { work, place, back, title } of entry.to ?? [])
        if (place === undefined && back === undefined && !waiting.has(work))
          waiting.set(work, title);
    return [...waiting].map(([work, title]) => ({ work, title }));
  };

  return {
    /** What it holds, read once. */
    load,
    push,
    /**
     * What was said in it, as a conversation: each message and each reply, in the order they
     * were answered, up to the number `to` if one is given; and the number it holds up to.
     */
    async said(to = Number.POSITIVE_INFINITY) {
      const held = await load();
      const said = held.records
        .filter((record) => record.entry.role !== "tool" && orderOf(record) <= to)
        .sort((a, b) => orderOf(a) - orderOf(b))
        .map(({ entry }) => ({ role: entry.role as "user" | "assistant", text: textOf(entry) }));
      return { said, upTo: held.last };
    },
    /**
     * Keep, under `id`, a reply the main loop gave after it had read up to `upTo`. `late` says
     * whether a message was said after that, which this reply doesn't answer. In a thread that
     * work follows it is `followed`: kept as no work's, so none takes it. `answers` names the
     * messages that came back which it answers: they are decided by this one write.
     */
    async answer(
      text: string,
      upTo: number,
      id: string,
      { followed = false, answers = [] }: { followed?: boolean; answers?: string[] } = {},
    ) {
      const held = await load();
      const reply = {
        ...mainEntry(text, upTo),
        ...(followed ? { to: [] } : {}),
        ...(answers.length > 0 ? { answers } : {}),
      };
      const { record, stored } = push(held, reply, id);
      await stored;
      const late = held.records.some(({ seq, entry }) => seq > upTo && entry.role === "user");
      return { entry: record.entry, late };
    },
    /**
     * Change a message from now on, in memory: `store` writes it as it is when its turn among
     * its writes comes, and `undo` takes this change back out of it, and no other made since.
     */
    change: (...args: Parameters<typeof change>) => change(...args),
    /**
     * The user messages that every piece of work they were given to has handed back, and the
     * main loop hasn't answered: each with who returned it and why.
     */
    async returned() {
      return returnedOf(await load());
    },
    /**
     * Have the messages `ids`, which name those they were given to, name `work` too, with its
     * title when it is new work: each then waits here for that work to take it.
     */
    async offer(ids: string[], work: string, title?: string) {
      const held = await load();
      for (const record of held.records) {
        if (!ids.includes(record.entry.id) || !record.entry.to) continue;
        if (record.entry.to.some((one) => one.work === work)) continue;
        const offered = change(
          held,
          record,
          (entry) => ({
            ...entry,
            to: [...(entry.to ?? []), { work, ...(title === undefined ? {} : { title }) }],
          }),
          (entry) => ({ ...entry, to: (entry.to ?? []).filter((one) => one.work !== work) }),
        );
        await offered.store().catch((error: unknown) => {
          offered.undo();
          throw error;
        });
      }
    },
    /** The work that messages here wait for, each named once, new work with its title. */
    async offers() {
      return offersOf(await load());
    },
    /**
     * What waits here, as the store has it: the messages that came back from all, and the work
     * that messages wait for, read once every message a piece of work is taking has been
     * stored as taken, or is waiting again.
     */
    async waiting() {
      const held = await load();
      while (held.records.some((record) => record.taking?.size))
        await Promise.all(held.records.map((record) => record.writes));
      return { returned: returnedOf(held), offers: offersOf(held) };
    },
    /** Messages before `before`, oldest first, as many as fit `limit` and `PAGE_BUDGET`. */
    async page(before: string | undefined, limit: number) {
      const records = (await load()).records.filter(({ entry }) => !entry.silent);
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
 * Its id is the name of its own thread, if it has one, whose messages are its unless they name
 * other work; in any other thread, the messages that name it are. A message's place in its
 * work's order is a count kept with it: each thing the work keeps or takes stands after all it
 * holds. One kept with no place stands where it does in its thread. A message given to several
 * pieces of work names each, with its place in each.
 * A message waiting for it in a thread it follows, one that names it and has no place there yet
 * or, in a thread that has no work of its own, one that names no work, it takes in the order it
 * was said, before it keeps anything else there.
 */
export function createRecord(options: {
  id: string;
  /** The threads it reads: those it follows, its own first, and those it has left. */
  follows(): string[];
  thread(name: string): Thread;
  /**
   * Whether what names no work in `thread` waits to be taken. It does where the thread has no
   * work of its own; where it has, that is that work's.
   */
  waits(thread: string): boolean;
  /** Whether it has left `thread`: it reads what it holds there, and takes and writes nothing. */
  left(thread: string): boolean;
}) {
  const { id } = options;
  /** Its hold on a message: its own among those the message names, or the message's own. */
  const holdOf = ({ entry }: Kept): Omit<Given, "work"> =>
    entry.to?.find((one) => one.work === id) ?? entry;
  const placeOf = (record: Kept) => holdOf(record).place ?? orderOf(record);
  const joinedOf = (record: Kept) => holdOf(record).joined === true;
  /** Whether a message naming those it was given to is still to be taken by this work. */
  const offered = ({ entry }: Kept) =>
    entry.to?.some(
      (one) => one.work === id && one.place === undefined && one.back === undefined,
    ) === true;
  const mine = (thread: string, record: Kept) =>
    record.entry.to
      ? record.entry.to.some((one) => one.work === id && one.place !== undefined)
      : record.entry.work === undefined
        ? thread === id
        : record.entry.work === id;
  /** Whether a message is not yet this work's to be sent: being written, or being taken by it. */
  const pending = (record: Kept) => record.writing === true || record.taking?.has(id) === true;
  /** A message as it is once this work has taken it at `place`. */
  const taken = (entry: Entry, place: number, joined: boolean): Entry => {
    const hold = { work: id, place, ...(joined ? { joined: true as const } : {}) };
    return entry.to
      ? { ...entry, to: entry.to.map((one) => (one.work === id ? hold : one)) }
      : { ...entry, ...hold };
  };
  /** That message as it was before this work took it: waiting for it again. */
  const untaken = (entry: Entry): Entry => {
    if (entry.to)
      return { ...entry, to: entry.to.map((one) => (one.work === id ? { work: id } : one)) };
    const { work: _, place: __, joined: ___, ...rest } = entry;
    return rest;
  };

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
    return records.sort((a, b) => placeOf(a.record) - placeOf(b.record));
  };
  /** The highest place among its messages. */
  const topOf = (records: Placed[]) => {
    const last = records.at(-1);
    return last ? placeOf(last.record) : 0;
  };
  /**
   * Take the messages waiting in `thread` as its own, after all it holds: at once in memory, and
   * `written` settles when each is stored, or rejects with the first that isn't, which stays
   * waiting with those after it. Like a message being written, the model is sent none of them
   * until that has settled.
   */
  const take = (held: Map<string, Held>, thread: string, joined: boolean) => {
    const from = held.get(thread) as Held;
    // What it was given by name; and what names nobody yet, in a thread that has no work of its
    // own to be that work's.
    // Not one still being written for the first time: it is taken once it is stored. And none
    // in a thread it has left.
    const waiting = from.records
      .filter(
        (record) =>
          !options.left(thread) &&
          !record.writing &&
          (record.entry.to
            ? offered(record)
            : thread !== id && !record.entry.work && options.waits(thread)),
      )
      .sort((a, b) => orderOf(a) - orderOf(b));
    // A message it takes has a whole number for its place: its worker's model names it by that.
    let top = Math.floor(topOf(own(held)));
    // Each gets its place in the order it was said and answered: at once in memory.
    const changes = waiting.map((record) => {
      const place = ++top;
      record.taking = (record.taking ?? new Set()).add(id);
      return options
        .thread(thread)
        .change(from, record, (entry) => taken(entry, place, joined), untaken);
    });
    // Stored one after another in that order, so what a crash or a refusal leaves taken is the
    // start of them: the rest stay waiting, and are taken after it.
    const written = (async () => {
      try {
        for (const [i, change] of changes.entries())
          await change.store().catch((error: unknown) => {
            for (const rest of changes.slice(i)) rest.undo();
            throw error;
          });
      } finally {
        for (const record of waiting) record.taking?.delete(id);
      }
    })();
    return { taken: waiting.length, written };
  };
  /** Whether a user message of its, stored already, follows the place `read`. */
  const saidAfter = (records: Placed[], read: number) =>
    records.some(
      ({ record }) => record.entry.role === "user" && placeOf(record) > read && !pending(record),
    );
  /**
   * Whether something the model reads after what a request made stands past the place `read`,
   * which that request had read up to: a user message, or what the main loop said as it stopped
   * the turn.
   */
  const heldBack = (records: Placed[], read: number) =>
    records.some(
      ({ record }) => placeOf(record) > read && (record.entry.role === "user" || joinedOf(record)),
    );
  /**
   * The thread of the newest user message it has not handed back: where it answers. With none
   * such, that of its newest; its own, with no message.
   */
  const whereOf = (records: Placed[]) => {
    const said = records.filter(
      ({ thread, record }) => record.entry.role === "user" && !options.left(thread),
    );
    const kept = said.findLast(({ record }) => holdOf(record).back === undefined);
    return (kept ?? said.at(-1))?.thread ?? id;
  };

  /** Keep an entry of its in `thread`, made once nothing waits there, from what the thread holds. */
  const keep = async (
    thread: string,
    make: (from: Held) => Omit<Entry, "id" | "at" | "work" | "place" | "ahead">,
    at: { id?: string; read?: number },
  ): Promise<{ entry: Entry; thread: string }> => {
    const held = await load();
    const from = held.get(thread) as Held;
    // What waits there is taken and stored first, so this is never kept ahead of it: it joins
    // a turn if this does, or comes of one. If the store won't take it, nothing is kept.
    const joins = make(from).joined === true || at.read !== undefined;
    await take(held, thread, joins).written;
    // From here to the push nothing waits, so its place and what is ahead of it are decided
    // with the record as it stands.
    const records = own(held);
    const { record, stored } = options.thread(thread).push(
      from,
      {
        ...make(from),
        ...(thread === id ? {} : { work: id }),
        place: Math.floor(topOf(records)) + 1,
        ...(at.read !== undefined && heldBack(records, at.read) ? { ahead: at.read } : {}),
      },
      at.id,
    );
    await stored;
    return { entry: record.entry, thread };
  };

  return {
    id,
    /**
     * Keep a message of its in `thread`, one of those it follows, after any waiting there. `read`
     * is given for what came of a model request that had read it up to that place: when a user
     * message was said since, or the turn was stopped by saying so, it is kept as `ahead` of
     * that.
     */
    append: (
      entry: Omit<Entry, "id" | "at" | "work" | "place" | "ahead">,
      at: { thread: string; id?: string; read?: number },
    ) => keep(at.thread, () => entry, at),
    /**
     * Keep in `thread` what the main loop said as it stopped a turn of this work. It stands after
     * all the thread holds, and like a message said in that turn, the work reads it after
     * whatever the turn still writes.
     */
    stopLine: (text: string, thread: string) =>
      keep(thread, (from) => ({ ...mainEntry(text, from.last), joined: true as const }), {}),
    /**
     * Take the messages waiting in `thread`, which it has come to follow, as its own: `joined`,
     * when a turn of its is running or a stopped one is still writing. It says how many there were to answer: in its own thread,
     * where nothing needs taking, those said since it last did anything itself.
     */
    async adopt(thread: string, joined: boolean): Promise<number> {
      const held = await load();
      const { taken, written } = take(held, thread, joined);
      await written;
      if (thread !== id) return taken;
      const records = own(held);
      const done = records.findLastIndex(
        ({ record: { entry } }) => entry.role !== "user" && entry.main === undefined,
      );
      // Those it was never given: kept there with no place, before it was the thread's work or
      // while nothing could give it them. One it was given and has not answered, as when its
      // turn was stopped, is not asked again by this.
      return (
        taken +
        records
          .slice(done + 1)
          .filter(
            ({ record: { entry } }) =>
              entry.role === "user" && entry.place === undefined && !entry.to,
          ).length
      );
    },
    /**
     * Hand the user message at `place` back, with why: once. It gives the thread it was said in,
     * and whether every piece of work it was given to has now handed it back; or nothing, when
     * this work has no such message or has handed it back already. `first` is called with that
     * thread before anything is stored.
     */
    async back(place: number, why: string, first: (thread: string) => Promise<void>) {
      const held = await load();
      const found = own(held).find(
        ({ record }) => record.entry.role === "user" && placeOf(record) === place,
      );
      if (!found || holdOf(found.record).back !== undefined) return undefined;
      const { thread, record } = found;
      await first(thread);
      const hold: Given = {
        work: id,
        place,
        ...(joinedOf(record) ? { joined: true as const } : {}),
        back: why,
      };
      const change = options.thread(thread).change(
        held.get(thread) as Held,
        record,
        // It names those it was given to from now on, which says the same of a single holder.
        ({ work: _, place: __, joined: ___, ...entry }) => ({
          ...entry,
          to: entry.to?.map((one) => (one.work === id ? hold : one)) ?? [hold],
        }),
        (entry) => ({
          ...entry,
          to: (entry.to ?? []).map((one) => {
            if (one.work !== id) return one;
            const { back: _, ...rest } = one;
            return rest;
          }),
        }),
      );
      await change.store().catch((error: unknown) => {
        change.undo();
        throw error;
      });
      return { thread, all: (record.entry.to ?? []).every((one) => one.back !== undefined) };
    },
    /**
     * Whether a user message of its, said since it last replied, is still its to answer: one it
     * has not handed back.
     */
    async unanswered(): Promise<boolean> {
      const records = own(await load());
      const reply = records.findLast(
        ({ record: { entry } }) => entry.role === "assistant" && entry.main === undefined,
      )?.record;
      // What its last reply had read: a message said during that turn stands past it.
      const read = reply ? (reply.entry.ahead ?? placeOf(reply)) : 0;
      return records.some(
        ({ record }) =>
          record.entry.role === "user" &&
          placeOf(record) > read &&
          holdOf(record).back === undefined,
      );
    },
    /**
     * Hand back what waits for it in `thread`, which it is leaving: a message there that names
     * it and that it never took is handed back unread, for that reason.
     */
    async drop(thread: string, why: string): Promise<{ all: boolean }> {
      const from = await options.thread(thread).load();
      const hold = (back?: string) => (entry: Entry) => ({
        ...entry,
        to: (entry.to ?? []).map((one) =>
          one.work === id ? { work: id, ...(back === undefined ? {} : { back }) } : one,
        ),
      });
      // At once in memory, like a taking; stored one after another, and from the first the
      // store refuses they wait for it again.
      const dropped = from.records.filter(offered);
      const changes = dropped.map((record) =>
        options.thread(thread).change(from, record, hold(why), hold()),
      );
      for (const [i, change] of changes.entries())
        await change.store().catch((error: unknown) => {
          for (const rest of changes.slice(i)) rest.undo();
          throw error;
        });
      return {
        all: dropped.some(({ entry }) => (entry.to ?? []).every((one) => one.back !== undefined)),
      };
    },
    /** The highest place it holds, as a whole number: what it keeps or takes next stands after. */
    async top(): Promise<number> {
      return Math.floor(topOf(own(await load())));
    },
    /**
     * Whether it holds a user message that stands after the place `place`: what a turn that
     * starts after that place keeps first. What a stopped turn still writes, and what the main
     * loop says, may stand there too, and is not that.
     */
    async after(place: number): Promise<boolean> {
      return own(await load()).some(
        ({ record }) => record.entry.role === "user" && placeOf(record) > place,
      );
    },
    /**
     * Whether it has had a turn that did something: it holds more than what was said to it and
     * what the main loop said.
     */
    async begun(): Promise<boolean> {
      return own(await load()).some(
        ({ record: { entry } }) => entry.role !== "user" && entry.main === undefined,
      );
    },
    /** What it last said, if anything. */
    async last(): Promise<string | undefined> {
      const said = own(await load()).findLast(
        ({ record: { entry } }) => entry.role === "assistant" && entry.main === undefined,
      );
      return said ? textOf(said.record.entry) : undefined;
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
     * The conversation to send: the newest exchanges (each from a user message that is not `joined`
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
      // Read up to the first user message that isn't its to send yet: one said after that waits
      // with it, so the model never reads a later message without an earlier one.
      const unwritten = records.find(({ record }) => pending(record));
      const read = unwritten ? placeOf(unwritten.record) - 1 : last;
      const unread = (record: Kept) => record.entry.role === "user" && placeOf(record) > read;
      const exchanges: Item[][] = [];
      /** Said during a turn, and not yet put: what is ahead of them goes first. */
      const late: Kept[] = [];
      const put = (record: Kept) => {
        const { entry } = record;
        const person = entry.role === "user";
        if ((person && !joinedOf(record)) || exchanges.length === 0) exchanges.push([]);
        // What a person said starts with its number, which is how the model names it.
        exchanges
          .at(-1)
          ?.push(
            ...(person
              ? entry.items.map((item) =>
                  item.type === "message"
                    ? { ...item, content: `[${placeOf(record)}] ${item.content}` }
                    : item,
                )
              : entry.items),
          );
      };
      /** Put the late messages placed up to `read`. */
      const putLate = (read: number) => {
        while (late[0] && placeOf(late[0]) <= read) put(late.shift() as Kept);
      };
      for (const { record } of records) {
        // Nothing to send: a user message still being written, or a line with no items.
        if (pending(record) || unread(record) || record.entry.items.length === 0) continue;
        if (joinedOf(record)) {
          late.push(record);
          continue;
        }
        putLate(record.entry.ahead ?? last);
        put(record);
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
      return { items, read, thread: whereOf(records.filter(({ record }) => !unread(record))) };
    },
    /** Whether a user message of its has been stored after the place `read`, which `input` gave. */
    async saidAfter(read: number): Promise<boolean> {
      return saidAfter(own(await load()), read);
    },
  };
}
export type LoopRecord = ReturnType<typeof createRecord>;

/**
 * The record a loop runs on, kept in a store: one key per message, holding the items a model reads
 * for it, and for a tool message the line a person sees. It is read once, then kept in memory, and
 * the oldest messages are deleted past a retention cap.
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
});
export type Entry = z.output<typeof Entry>;

/** Where a record's messages are kept in its store. */
export const MESSAGES = "msg/";
const keyOf = (seq: number) => `${MESSAGES}${String(seq).padStart(12, "0")}`;
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

interface Kept {
  key: string;
  entry: Entry;
  bytes: number;
}

export function createRecord(
  store: Store,
  log: Log,
  limits = { keep: KEEP, keepBytes: KEEP_BYTES },
) {
  let loaded: Promise<{ records: Kept[]; last: number; bytes: number }> | undefined;

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
            last = Math.max(last, Number(key.slice(MESSAGES.length)) || 0);
            const parsed = Entry.safeParse(values[i]?.value);
            if (!parsed.success) {
              log.warn("A stored message didn't read back; it is left out.", { key });
              return;
            }
            const record = { key, entry: parsed.data, bytes: size(parsed.data) };
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
    /**
     * Keep a message, under `id` or its own number, and delete the oldest past the cap. A tool
     * message the store refuses is still kept in memory, since its call has run.
     */
    async append(entry: Omit<Entry, "id" | "at">, id?: string): Promise<Entry> {
      const state = await load();
      const key = keyOf(++state.last);
      const record = {
        key,
        entry: kept({
          id: id ?? key.slice(MESSAGES.length),
          at: new Date().toISOString(),
          ...entry,
        }),
        bytes: 0,
      };
      record.bytes = size(record.entry);
      state.records.push(record);
      state.bytes += record.bytes;
      try {
        await store.set({ key, value: record.entry as Json });
      } catch (error) {
        if (entry.role !== "tool") {
          state.records.splice(state.records.indexOf(record), 1);
          state.bytes -= record.bytes;
          throw error;
        }
        log.error("A tool message couldn't be stored; it is kept until a restart.", {
          error: String(error),
        });
      }
      while (
        state.records.length > 1 &&
        (state.records.length > limits.keep || state.bytes > limits.keepBytes)
      ) {
        const oldest = state.records.shift() as Kept;
        state.bytes -= oldest.bytes;
        await store.delete({ key: oldest.key }).catch((error: unknown) =>
          log.warn("An old message couldn't be deleted.", {
            key: oldest.key,
            error: String(error),
          }),
        );
      }
      return record.entry;
    },
    /** Forget everything after the message `id`: a retry takes the place of what followed it. */
    async dropAfter(id: string) {
      const state = await load();
      const at = state.records.findLastIndex((record) => record.entry.id === id);
      if (at === -1) return;
      for (const gone of state.records.splice(at + 1)) {
        state.bytes -= gone.bytes;
        await store.delete({ key: gone.key }).catch((error: unknown) =>
          log.warn("A replaced message couldn't be deleted.", {
            key: gone.key,
            error: String(error),
          }),
        );
      }
    },
    /** The person's last message, if any. */
    async lastUser(): Promise<Entry | undefined> {
      return (await load()).records.findLast((record) => record.entry.role === "user")?.entry;
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
    /**
     * The conversation to send: the newest exchanges (each from a user message on) that fit the
     * budget, and always the latest two, so "go on" after a long turn still has that turn. When
     * those two are over the budget, their oldest function arguments and outputs are left out,
     * each call still paired with an output.
     */
    async input(): Promise<Item[]> {
      const { records } = await load();
      const exchanges: Item[][] = [];
      for (const { entry } of records) {
        if (entry.role === "user" || exchanges.length === 0) exchanges.push([]);
        exchanges.at(-1)?.push(...entry.items);
      }
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
      return items;
    },
  };
}
export type LoopRecord = ReturnType<typeof createRecord>;

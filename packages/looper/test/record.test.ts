import assert from "node:assert/strict";
import test from "node:test";
import { createRecord, createThread, fitted, head, INPUT_BUDGET } from "../src/record.ts";
import type { Store } from "../src/types.ts";

/** A store in memory, as the record uses it. */
function store() {
  const values = new Map<string, unknown>();
  return {
    values,
    calls: {
      get: async ({ key }: { key: string }) =>
        values.has(key) ? { value: values.get(key) as never } : {},
      set: async ({ key, value }: { key: string; value: unknown }) => {
        values.set(key, value);
        return {};
      },
      delete: async ({ key }: { key: string }) => ({ deleted: values.delete(key) }),
      list: async ({ prefix = "", after }: { prefix?: string; after?: string }) => ({
        keys: [...values.keys()]
          .filter((k) => k.startsWith(prefix) && (after === undefined || k > after))
          .sort(),
        next: null,
      }),
    },
  };
}
const log = { info() {}, warn() {}, error() {} };
/** A piece of work that follows only its own thread, `t`, kept in a store. */
function single(calls: Store, limits?: { keep: number; keepBytes: number }) {
  const thread = createThread(calls, log, limits);
  const record = createRecord({
    id: "t",
    follows: () => ["t"],
    thread: () => thread,
    waits: () => true,
    left: () => false,
  });
  type Said = Parameters<typeof record.append>[0];
  return {
    append: async (entry: Said, id?: string, read?: number) =>
      (
        await record.append(entry, {
          thread: "t",
          ...(id === undefined ? {} : { id }),
          ...(read === undefined ? {} : { read }),
        })
      ).entry,
    page: thread.page,
    input: record.input,
    saidAfter: record.saidAfter,
  };
}
const user = (content: string) => ({
  role: "user" as const,
  items: [{ type: "message" as const, role: "user" as const, content }],
});

test("the oldest messages are deleted past the cap, by count and by bytes", async () => {
  const s = store();
  const record = single(s.calls as never, { keep: 5, keepBytes: 1_000_000 });
  for (let i = 1; i <= 12; i++) await record.append(user(`m${i}`));
  assert.equal(s.values.size, 5);
  const page = await record.page(undefined, 100);
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["m8", "m9", "m10", "m11", "m12"],
  );
  // A restart reads only what is kept, and numbers go on.
  const again = single(s.calls as never, { keep: 5, keepBytes: 1_000_000 });
  await again.append(user("m13"));
  assert.deepEqual(
    (await again.page(undefined, 100)).messages.map((m) => m.text),
    ["m9", "m10", "m11", "m12", "m13"],
  );

  const t = store();
  const bytes = single(t.calls as never, { keep: 1000, keepBytes: 2_000 });
  for (let i = 0; i < 10; i++) await bytes.append(user("x".repeat(500)));
  assert.ok(t.values.size <= 4);
});

test("text is cut at a character and says so", () => {
  assert.equal(head("a😀b", 2), "a");
  const cut = fitted("😀".repeat(100_000), 1000);
  assert.ok(new TextEncoder().encode(JSON.stringify(cut)).byteLength <= 1000);
  assert.match(cut, /… \(cut\)$/);
  assert.doesNotMatch(cut, /[\uD800-\uDBFF]… \(cut\)$/);
});

test("the record is first read a few at a time, in order", async () => {
  const s = store();
  const writer = single(s.calls as never);
  for (let i = 1; i <= 50; i++) await writer.append(user(`m${i}`));
  let reading = 0;
  let most = 0;
  const get = s.calls.get;
  s.calls.get = async (input) => {
    most = Math.max(most, ++reading);
    await new Promise((done) => setTimeout(done, 1));
    reading--;
    return get(input);
  };
  const page = await single(s.calls as never).page(undefined, 100);
  assert.deepEqual(
    page.messages.map((m) => m.text),
    Array.from({ length: 50 }, (_, i) => `m${i + 1}`),
  );
  assert.ok(most > 1 && most <= 16, `${most} at once`);
});

test("a message said during a turn is read after what was asked for without it, in one exchange", async () => {
  const record = single(store().calls as never);
  const reply = (content: string) => ({
    role: "assistant" as const,
    items: [{ type: "message" as const, role: "assistant" as const, content }],
  });
  const during = (content: string) => ({ ...user(content), joined: true as const });
  const large = "x".repeat(INPUT_BUDGET * 0.6);
  await record.append(user("old"));
  await record.append(reply("old reply"));
  await record.append(user("open"));
  const first = await record.input();
  await record.append(during("one"));
  assert.equal(await record.saidAfter(first.read), true);
  // What came of the request that read up to `open` is ahead of `one`.
  await record.append(reply(`to open ${large}`), undefined, first.read);
  const second = await record.input();
  assert.equal(await record.saidAfter(second.read), false);
  await record.append(during("two"));
  // What came of the request that read `one` follows it, and is ahead of `two` only.
  await record.append(reply(`to one ${large}`), undefined, second.read);
  await record.append(during("three"));
  await record.append(reply("to two and three"), undefined, (await record.input()).read);
  // The turn is over the budget, and stays whole from the message that opened it: it is one
  // exchange, not four.
  assert.deepEqual(
    (await record.input()).items.map((item) =>
      item.type === "message" ? item.content.slice(0, 9) : "",
    ),
    // Each thing the person said starts with its number, which is its place in the record.
    [
      "[1] old",
      "old reply",
      "[3] open",
      "to open x",
      "[4] one",
      "to one xx",
      "[6] two",
      "[8] three",
      "to two an",
    ],
  );
});

test("a user message is sent to the model only once it is stored", async () => {
  const s = store();
  const record = single(s.calls as never);
  await record.append(user("open"));
  let stored: () => void = () => {};
  const set = s.calls.set;
  s.calls.set = async (input) => {
    await new Promise<void>((resolve) => {
      stored = resolve;
    });
    return set(input);
  };
  const appending = record.append({ ...user("on its way"), joined: true });
  const before = await record.input();
  assert.equal(before.items.length, 1);
  assert.equal(await record.saidAfter(before.read), false);
  stored();
  await appending;
  // Stored, it is after what that request read.
  assert.equal(await record.saidAfter(before.read), true);
  assert.equal((await record.input()).items.length, 2);
});

test("a piece of work that follows two threads reads its messages in the order they were kept", async () => {
  const a = createThread(store().calls as never, log);
  const c = createThread(store().calls as never, log);
  const following = ["a"];
  const record = createRecord({
    id: "a",
    follows: () => following,
    thread: (name) => (name === "a" ? a : c),
    waits: (thread) => thread === "c",
    left: () => false,
  });
  const said = (content: string) => user(content);
  const reply = (content: string) => ({
    role: "assistant" as const,
    items: [{ type: "message" as const, role: "assistant" as const, content }],
  });
  await record.append(said("in a"), { thread: "a" });
  await record.append(reply("to a"), { thread: "a" });
  // A message kept in another thread before the work followed it names no work yet.
  const held = await c.load();
  await c.push(held, said("in c")).stored;
  assert.equal(await record.where(), "a");
  following.push("c");
  await record.adopt("c", false);
  assert.deepEqual(
    held.records.map(({ entry }) => [entry.work, entry.place]),
    [["a", 3]],
  );
  // It answers where its newest message is, and that reply says whose it is too.
  assert.equal(await record.where(), "c");
  const kept = await record.append(reply("to c"), { thread: "c" });
  assert.deepEqual([kept.entry.work, kept.entry.place], ["a", 4]);
  // Back in its own thread, a message has its place in the work's order, and names no work.
  const own = await record.append(said("in a again"), { thread: "a" });
  assert.deepEqual([own.entry.work, own.entry.place], [undefined, 5]);
  const { items, thread } = await record.input();
  assert.deepEqual(
    items.map((item) => (item.type === "message" ? item.content : "")),
    ["[1] in a", "to a", "[3] in c", "to c", "[5] in a again"],
  );
  assert.equal(thread, "a");
  // Each thread shows what was said in it, and nothing of the other.
  assert.deepEqual(
    (await c.page(undefined, 10)).messages.map((message) => message.text),
    ["in c", "to c"],
  );
  assert.deepEqual(
    (await a.page(undefined, 10)).messages.map((message) => message.text),
    ["in a", "to a", "in a again"],
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { createRecord, fitted, head, INPUT_BUDGET } from "../src/record.ts";

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
const user = (content: string) => ({
  role: "user" as const,
  items: [{ type: "message" as const, role: "user" as const, content }],
});

test("the oldest messages are deleted past the cap, by count and by bytes", async () => {
  const s = store();
  const record = createRecord(s.calls as never, log, { keep: 5, keepBytes: 1_000_000 });
  for (let i = 1; i <= 12; i++) await record.append(user(`m${i}`));
  assert.equal(s.values.size, 5);
  const page = await record.page(undefined, 100);
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["m8", "m9", "m10", "m11", "m12"],
  );
  // A restart reads only what is kept, and numbers go on.
  const again = createRecord(s.calls as never, log, { keep: 5, keepBytes: 1_000_000 });
  await again.append(user("m13"));
  assert.deepEqual(
    (await again.page(undefined, 100)).messages.map((m) => m.text),
    ["m9", "m10", "m11", "m12", "m13"],
  );

  const t = store();
  const bytes = createRecord(t.calls as never, log, { keep: 1000, keepBytes: 2_000 });
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
  const writer = createRecord(s.calls as never, log);
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
  const page = await createRecord(s.calls as never, log).page(undefined, 100);
  assert.deepEqual(
    page.messages.map((m) => m.text),
    Array.from({ length: 50 }, (_, i) => `m${i + 1}`),
  );
  assert.ok(most > 1 && most <= 16, `${most} at once`);
});

test("a message said during a turn is read after what was asked for without it, in one exchange", async () => {
  const record = createRecord(store().calls as never, log);
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
      item.type === "message" ? item.content.slice(0, 7) : "",
    ),
    ["old", "old rep", "open", "to open", "one", "to one ", "two", "three", "to two "],
  );
});

test("a user message is sent to the model only once it is stored", async () => {
  const s = store();
  const record = createRecord(s.calls as never, log);
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

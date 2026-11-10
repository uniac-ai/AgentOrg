import assert from "node:assert/strict";
import test from "node:test";
import { createRecord, fitted, head } from "../src/record.ts";

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

test("dropAfter forgets what followed a message, in memory and in the store", async () => {
  const s = store();
  const record = createRecord(s.calls as never, log);
  const kept = await record.append(user("kept"));
  await record.append(user("gone 1"));
  await record.append(user("gone 2"));
  await record.dropAfter(kept.id);
  assert.equal(s.values.size, 1);
  assert.deepEqual(
    (await record.page(undefined, 100)).messages.map((m) => m.text),
    ["kept"],
  );
  // And a new message after it isn't given a number that was used.
  await record.append(user("next"));
  assert.deepEqual(
    (await createRecord(s.calls as never, log).page(undefined, 100)).messages.map((m) => m.text),
    ["kept", "next"],
  );
});

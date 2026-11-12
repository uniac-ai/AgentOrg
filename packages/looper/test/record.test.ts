import assert from "node:assert/strict";
import test from "node:test";
import { CUT_STEP, createRecord, createThread, fitted, head, INPUT_BUDGET } from "../src/record.ts";
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

const reply = (content: string) => ({
  role: "assistant" as const,
  items: [{ type: "message" as const, role: "assistant" as const, content }],
});
/** A call that was given `given` and gave back `output`. */
const ran = (callId: string, output: string, given = "{}") => ({
  role: "tool" as const,
  text: `look: done`,
  state: "done" as const,
  items: [
    { type: "function_call" as const, callId, name: "look", arguments: given },
    { type: "function_call_output" as const, callId, output },
  ],
});
/** What is sent, each item in a few words: what was said without its number, and for a call's parts whether they were left out. */
const sent = async (record: ReturnType<typeof single>) =>
  (await record.input()).items.map((item) =>
    item.type === "message"
      ? item.content.replace(/^\[\d+\] /, "").slice(0, 40)
      : item.type === "function_call"
        ? `call ${item.callId}${item.arguments.includes("left_out") ? " (left out)" : ""}`
        : `output ${item.callId}${item.output.startsWith("(Left out") ? " (left out)" : ""}`,
  );
/** Text of this share of the budget. */
const filler = (share: number) => "x".repeat(INPUT_BUDGET * share);

test("over the budget, what was run goes before anything that was said, the oldest first, and the latest exchange's last", async () => {
  const record = single(store().calls as never);
  await record.append(user("the task"));
  await record.append(ran("a1", filler(0.3)));
  await record.append(ran("a2", filler(0.3)));
  await record.append(reply("did a"));
  await record.append(user("and b"));
  await record.append(ran("b1", filler(0.3)));
  await record.append(reply("did b"));
  await record.append(user("now c"));
  await record.append(ran("c1", filler(0.3)));
  // A fifth over: one step is cut, which is the oldest output and no more.
  assert.deepEqual(await sent(record), [
    "the task",
    "call a1",
    "output a1 (left out)",
    "call a2",
    "output a2",
    "did a",
    "and b",
    "call b1",
    "output b1",
    "did b",
    "now c",
    "call c1",
    "output c1",
  ]);
  // Far over: every output of the past goes before anything that was said, and the exchange
  // under way keeps its own until nothing else is left.
  await record.append(ran("c2", filler(0.9)));
  const all = await sent(record);
  assert.deepEqual(
    all.filter((one) => one.startsWith("output")),
    [
      "output a1 (left out)",
      "output a2 (left out)",
      "output b1 (left out)",
      "output c1",
      "output c2",
    ],
  );
  assert.deepEqual(
    all.filter((one) => !one.startsWith("output") && !one.startsWith("call")),
    ["the task", "did a", "and b", "did b", "now c"],
  );
});

test("when what was said is itself too much, whole exchanges go except the opening message and the latest two, and one line says after and before which", async () => {
  const record = single(store().calls as never);
  // Each exchange says more than a third of the budget, in two replies.
  const exchange = async (asked: string, name: string) => {
    await record.append(user(asked));
    await record.append(reply(`${name}1 ${filler(0.2)}`));
    await record.append(reply(`${name}2 ${filler(0.2)}`));
  };
  await exchange("the task", "a");
  await exchange("second", "b");
  await exchange("third", "c");
  await record.append(user("go on"));
  const { items } = await record.input();
  const said = items.map((item) => (item.type === "message" ? item.content.slice(0, 12) : ""));
  // The opening message with its number, the line, and what still fits, whole.
  assert.equal(said[0], "[1] the task");
  assert.equal(
    (items[1] as { content?: string }).content,
    "(Left out: all that was said and done after [1] and before [4]. The conversation was too large to send it.)",
  );
  assert.deepEqual(
    said.slice(2).map((one) => one.replace(/^\[\d+\] /, "").slice(0, 5)),
    ["secon", "b1 xx", "b2 xx", "third", "c1 xx", "c2 xx", "go on"],
  );
  // Whole exchanges go before anything the latest exchange ran: its output is as it was.
  await record.append(ran("z", filler(0.3)));
  assert.deepEqual(
    (await sent(record)).map((one) => one.slice(0, 8)),
    ["the task", "(Left ou", "third", "c1 xxxxx", "c2 xxxxx", "go on", "call z", "output z"],
  );
  // The latest two always stay, and what was said in them is never cut: they are sent though
  // they alone are over the budget.
  await record.append(reply(`d1 ${filler(0.4)}`));
  await record.append(reply(`d2 ${filler(0.4)}`));
  const over = (await record.input()).items;
  assert.deepEqual(
    over.map((item) =>
      item.type === "message" ? item.content.replace(/^\[\d+\] /, "").slice(0, 5) : "",
    ),
    ["the t", "(Left", "third", "c1 xx", "c2 xx", "go on", "", "", "d1 xx", "d2 xx"],
  );
  assert.ok(new TextEncoder().encode(JSON.stringify(over)).byteLength > INPUT_BUDGET);
});

test("a line stands only where something was left out, and with message [1] gone it says only before which", async () => {
  // Nothing between the opening message and the next: both are sent, with no line between.
  const close = single(store().calls as never);
  await close.append(user("the task"));
  await close.append(user("and this"));
  await close.append(reply(`a1 ${filler(0.4)}`));
  await close.append(reply(`a2 ${filler(0.4)}`));
  await close.append(user("go on"));
  await close.append(reply(`b1 ${filler(0.4)}`));
  assert.deepEqual(
    (await sent(close)).map((one) => one.slice(0, 8)),
    ["the task", "and this", "a1 xxxxx", "a2 xxxxx", "go on", "b1 xxxxx"],
  );
  // A record that keeps eleven messages has lost its first two: there is no opening message
  // to keep, and the line names only the message it stands before.
  const short = single(store().calls as never, { keep: 11, keepBytes: 64 * 1024 * 1024 });
  for (const [asked, name] of [
    ["the task", "a"],
    ["second", "b"],
    ["third", "c"],
    ["fourth", "d"],
  ]) {
    await short.append(user(asked as string));
    await short.append(reply(`${name}1 ${filler(0.3)}`));
    await short.append(reply(`${name}2 ${filler(0.3)}`));
  }
  await short.append(user("go on"));
  const { items } = await short.input();
  assert.deepEqual(
    items.map((item) => (item.type === "message" ? item.content.slice(0, 12) : "")),
    ["(Left out: a", "[10] fourth", "d1 xxxxxxxxx", "d2 xxxxxxxxx", "[13] go on"],
  );
  assert.equal(
    (items[0] as { content?: string }).content,
    "(Left out: all that was said and done before [10]. The conversation was too large to send it.)",
  );
});

test("the latest exchange's calls go last, and a call's part is left out only when that makes it smaller", async () => {
  const record = single(store().calls as never);
  await record.append(user("the task"));
  await record.append(ran("small", "ok"));
  await record.append(ran("a1", filler(0.4)));
  await record.append(ran("a2", filler(0.4), JSON.stringify({ text: filler(0.3) })));
  await record.append(ran("a3", filler(0.3)));
  // One exchange, so nothing of the past to cut: its own oldest go, each call still with an
  // output, and the short output stays as it is, being shorter than the words for one left out.
  assert.deepEqual(await sent(record), [
    "the task",
    "call small",
    "output small",
    "call a1",
    "output a1 (left out)",
    "call a2 (left out)",
    "output a2",
    "call a3",
    "output a3",
  ]);
});

test("the same is left out while a conversation grows within one step, so the requests begin alike", async () => {
  const record = single(store().calls as never);
  await record.append(user("the task"));
  for (let i = 0; i < 8; i++) await record.append(ran(`a${i}`, filler(0.14)));
  await record.append(user("go on"));
  const first = await record.input();
  const cut = (items: typeof first.items) =>
    items.filter((item) => item.type === "function_call_output" && item.output.startsWith("(Left"))
      .length;
  assert.ok(cut(first.items) > 0);
  // A little more is done: what is sent begins exactly as before, and nothing more is cut.
  await record.append(ran("b0", "y".repeat(CUT_STEP / 10)));
  await record.append(ran("b1", "y".repeat(CUT_STEP / 10)));
  const second = await record.input();
  assert.deepEqual(second.items.slice(0, first.items.length), first.items);
  assert.equal(cut(second.items), cut(first.items));
  // Past the step, more is cut, and from then the beginning is the new one.
  await record.append(ran("b2", "y".repeat(CUT_STEP)));
  assert.ok(cut((await record.input()).items) > cut(first.items));
});

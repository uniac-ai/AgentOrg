import assert from "node:assert/strict";
import test from "node:test";
import { COMPACTION_LINE } from "../src/compaction.ts";
import { CUT_STEP, createRecord, createThread, fitted, INPUT_BUDGET } from "../src/record.ts";
import { cut, cutInside, head, type Item, type Picture, type Store } from "../src/types.ts";

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
    toCompact: record.toCompact,
  };
}
const user = (content: string) => ({
  role: "user" as const,
  items: [{ type: "message" as const, role: "user" as const, content }],
});

test("past the cap, the oldest calls are deleted and then the oldest pictures, never what was said", async () => {
  const s = store();
  const record = single(s.calls as never, { keep: 5, keepBytes: 1_000_000 });
  const callsSent = async () =>
    (await record.input()).items.flatMap((item) =>
      item.type === "function_call" ? [item.callId] : [],
    );
  await record.append(user("m1"));
  for (let i = 1; i <= 6; i++) await record.append(ran(`c${i}`, "seen"));
  await record.append(user("m2"));
  // Five calls kept: the oldest went, and both messages stay.
  assert.equal(s.values.size, 7);
  assert.deepEqual(await callsSent(), ["c2", "c3", "c4", "c5", "c6"]);
  // What was said isn't counted, and stays however much of it there is: calls after it are kept
  // as before, and a restart reads it all.
  for (let i = 3; i <= 8; i++) await record.append(user(`m${i}`));
  await record.append(ran("c7", "seen"));
  await record.append(ran("c8", "seen"));
  assert.deepEqual(await callsSent(), ["c4", "c5", "c6", "c7", "c8"]);
  const said = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
  assert.deepEqual(
    (await record.page(undefined, 100)).messages.map((m) => m.text),
    said,
  );
  const again = single(s.calls as never, { keep: 5, keepBytes: 1_000_000 });
  await again.append(user("m9"));
  assert.deepEqual(
    (await again.page(undefined, 100)).messages.map((m) => m.text),
    [...said, "m9"],
  );

  // A work's newest call holds its place, and stays however old: here another work's, in a thread
  // that keeps two calls.
  const shared = createThread(store().calls as never, log, { keep: 2, keepBytes: 1_000_000 });
  const work = (id: string) =>
    createRecord({
      id,
      follows: () => ["t"],
      thread: () => shared,
      waits: () => true,
      left: () => false,
    });
  const own = work("t");
  const other = work("w2");
  const callsOf = async (one: typeof own) =>
    (await one.input()).items.flatMap((item) =>
      item.type === "function_call" ? [item.callId] : [],
    );
  await own.append(user("go"), { thread: "t" });
  await other.append(ran("b1", "seen"), { thread: "t" });
  for (const id of ["a1", "a2", "a3"]) await own.append(ran(id, "seen"), { thread: "t" });
  assert.deepEqual(await callsOf(other), ["b1"]);
  assert.deepEqual(await callsOf(own), ["a3"]);

  // Past its bytes, the oldest pictures of answered messages are left out, each by a line; an
  // open message keeps its own, and every word stays.
  const t = store();
  const bytes = single(t.calls as never, { keep: 1000, keepBytes: 2_000 });
  await bytes.append(ran("k1", "seen"));
  await bytes.append(userWith("q0", [picture("Q0", 600)]));
  for (let i = 1; i <= 3; i++) {
    const { id } = await bytes.append(userWith(`p${i}`, [picture(`P${i}`, 600)]));
    await bytes.append({
      role: "assistant",
      closes: id,
      items: [{ type: "message", role: "assistant", content: `seen ${i}` }],
    });
  }
  const shown = async (record: ReturnType<typeof single>) =>
    (await record.page(undefined, 100)).messages
      .filter((m) => m.role === "user")
      .map((m) => [m.text, m.images?.length ?? 0]);
  const expected = [
    ["q0", 1],
    ["p1\n(A picture, left out.)", 0],
    ["p2", 1],
    ["p3", 1],
  ];
  assert.deepEqual(await shown(bytes), expected);
  // And so it is stored. Pictures have a budget of their own: no call went for them.
  const stored = single(t.calls as never, { keep: 1000, keepBytes: 2_000 });
  assert.deepEqual(await shown(stored), expected);
  assert.ok(
    (await stored.input()).items.some(
      (item) => item.type === "function_call" && item.callId === "k1",
    ),
  );
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
  /** What the worker wrote. */
  const reply = (content: string) => ({
    role: "assistant" as const,
    unsent: true as const,
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
  /** A reply sent to the message of that number and id. */
  const reply = (text: string, message: number, closes: string) => ({
    role: "assistant" as const,
    closes,
    items: [
      {
        type: "function_call" as const,
        callId: `send-${message}`,
        name: "send",
        arguments: JSON.stringify({ message, text }),
      },
      { type: "function_call_output" as const, callId: `send-${message}`, output: "Sent." },
    ],
  });
  const inA = await record.append(said("in a"), { thread: "a" });
  await record.append(reply("to a", 1, inA.entry.id), { thread: "a" });
  // A message kept in another thread before the work followed it names no work yet.
  const held = await c.load();
  const inC = c.push(held, said("in c"));
  await inC.stored;
  assert.equal(await record.where(), "a");
  following.push("c");
  await record.adopt("c", false);
  assert.deepEqual(
    held.records.map(({ entry }) => [entry.work, entry.place]),
    [["a", 3]],
  );
  // It answers where its newest message is, and that reply says whose it is too.
  assert.equal(await record.where(), "c");
  const kept = await record.append(reply("to c", 3, inC.record.entry.id), { thread: "c" });
  assert.deepEqual([kept.entry.work, kept.entry.place], ["a", 4]);
  // Back in its own thread, a message has its place in the work's order, and names no work.
  const own = await record.append(said("in a again"), { thread: "a" });
  assert.deepEqual([own.entry.work, own.entry.place], [undefined, 5]);
  const { items, thread } = await record.input();
  // What was sent is read as its call.
  assert.deepEqual(
    items.flatMap((item) =>
      item.type === "message"
        ? [item.content]
        : item.type === "function_call"
          ? [(JSON.parse(item.arguments) as { text: string }).text]
          : [],
    ),
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

/** What a worker wrote. */
const reply = (content: string) => ({
  role: "assistant" as const,
  unsent: true as const,
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
  // A record an earlier version cut has lost its first two: there is no opening message to keep,
  // and the line names only the message it stands before.
  const earlier = store();
  const writer = single(earlier.calls as never);
  for (const [asked, name] of [
    ["the task", "a"],
    ["second", "b"],
    ["third", "c"],
    ["fourth", "d"],
  ]) {
    await writer.append(user(asked as string));
    await writer.append(reply(`${name}1 ${filler(0.3)}`));
    await writer.append(reply(`${name}2 ${filler(0.3)}`));
  }
  for (const key of [...earlier.values.keys()].sort().slice(0, 2)) earlier.values.delete(key);
  const short = single(earlier.calls as never);
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
  // The arguments a2 was given were cut inside as they were kept; a1's output covers the cut,
  // so they are sent as stored.
  assert.deepEqual(await sent(record), [
    "the task",
    "call small",
    "output small",
    "call a1",
    "output a1 (left out)",
    "call a2",
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

/** A picture named by its first letters, of `size` characters. */
const picture = (name: string, size: number): Picture => ({
  mediaType: "image/png",
  data: name.padEnd(size, "A"),
});
const userWith = (content: string, images: Picture[]) => ({
  role: "user" as const,
  items: [{ type: "message" as const, role: "user" as const, content, images }],
});
const ranWith = (callId: string, output: string, images: Picture[]) => ({
  ...ran(callId, output),
  items: [
    { type: "function_call" as const, callId, name: "look", arguments: "{}" },
    { type: "function_call_output" as const, callId, output, images },
  ],
});
/** Each item that has words or pictures, as its words' first line and the names of its pictures. */
const pictured = (items: Item[]) =>
  items.flatMap((item) => {
    if (item.type === "function_call") return [];
    const words = (item.type === "message" ? item.content : item.output).replace(/^\[\d+\] /, "");
    const names = (item.images ?? []).map((one) => one.data.replace(/A+$/, ""));
    return [[words.replaceAll("\n", " | "), ...names].join(" ")];
  });

test("a request gives the pictures sent with the messages its turn answers, then its calls', then older ones; each left out is said where it was", async () => {
  const record = single(store().calls as never);
  await record.append(userWith("first", [picture("p1", 200_000)]));
  await record.append(ranWith("a", "a screen", [picture("t1", 100_000)]));
  await record.append(reply("did it"));
  await record.append(userWith("second", [picture("p2", 200_000), picture("p3", 200_000)]));
  await record.append(ranWith("b", "another", [picture("t2", 100_000)]));
  // The two sent with this turn's message, then this turn's call's: the person's older one no
  // longer fits, and the call's of the turn before is not given.
  assert.deepEqual(pictured((await record.input()).items), [
    "first | (A picture, left out.)",
    "a screen | (A picture, left out.)",
    "did it",
    "second p2 p3",
    "another t2",
  ]);
  // With less room beside what else the request carries, those sent with this turn's message
  // come first: the newest only, and no call's.
  const besides = (room: number) => "x".repeat(1_000_000 - room);
  assert.deepEqual(pictured((await record.input(besides(250_000))).items), [
    "first | (A picture, left out.)",
    "a screen | (A picture, left out.)",
    "did it",
    "second | (A picture, left out.) p3",
    "another | (A picture, left out.)",
  ]);
  assert.deepEqual(
    pictured((await record.input(besides(0))).items).at(-2),
    "second | (A picture, left out.) | (A picture, left out.)",
  );
});

test("a large picture the person sent early leaves the room to a later turn's screenshots", async () => {
  const record = single(store().calls as never);
  await record.append(userWith("look at this", [picture("q", 100_000), picture("p", 450_000)]));
  await record.append(reply("seen"));
  await record.append(user("now open it"));
  await record.append(ranWith("s", "a screen", [picture("s", 300_000)]));
  assert.deepEqual(pictured((await record.input()).items), [
    // The large one gives way to the screenshot; the smaller one still fits after it.
    "look at this | (A picture, left out.) q",
    "seen",
    "now open it",
    "a screen s",
  ]);
});

test("a turn that opens on several messages gives the pictures of each first", async () => {
  const record = single(store().calls as never);
  await record.append(userWith("this is the screen", [picture("m", 450_000)]));
  await record.append(user("fix it"));
  await record.append(ranWith("s", "a screen", [picture("s", 300_000)]));
  assert.deepEqual(pictured((await record.input()).items), [
    "this is the screen m",
    "fix it",
    "a screen | (A picture, left out.)",
  ]);
});

test("pictures don't count toward the conversation's budget, and kept and paged they stay with their message", async () => {
  const s = store();
  const record = single(s.calls as never);
  await record.append(userWith("the task", [picture("p1", 400_000)]));
  await record.append(ran("a", filler(0.9)));
  const { items } = await record.input();
  assert.deepEqual(
    pictured(items).map((one) => one.slice(0, 12)),
    ["the task p1", "xxxxxxxxxxxx"],
  );
  // Kept as said, and shown with the message in its thread's page.
  const again = single(s.calls as never);
  assert.deepEqual(
    pictured((await again.input()).items).map((one) => one.slice(0, 12)),
    ["the task p1", "xxxxxxxxxxxx"],
  );
  const { messages } = await again.page(undefined, 10);
  assert.equal(messages[0]?.images?.[0]?.data.slice(0, 2), "p1");
});

test("a request's pictures have the room its words, instructions and tools leave, at most their budget", async () => {
  const record = single(store().calls as never);
  await record.append(userWith("the task", [picture("p1", 300_000)]));
  const given = async (besides: unknown) => pictured((await record.input(besides)).items)[0];
  assert.equal(await given({ instructions: "x".repeat(600_000) }), "the task p1");
  assert.equal(
    await given({ instructions: "x".repeat(750_000) }),
    "the task | (A picture, left out.)",
  );
  // The words take their share as they are, not at their budget.
  await record.append(ran("a", filler(0.45)));
  await record.append(ran("b", filler(0.45)));
  assert.equal(await given({ instructions: "x".repeat(300_000) }), "the task p1");
  assert.equal(
    await given({ instructions: "x".repeat(400_000) }),
    "the task | (A picture, left out.)",
  );
});

test("pictures are given once the conversation is fitted: what is left out of it takes no room", async () => {
  const record = single(store().calls as never);
  await record.append(user("the task"));
  await record.append(userWith("second", [picture("p2", 300_000)]));
  await record.append(reply(`b1 ${filler(0.3)}`));
  await record.append(reply(`b2 ${filler(0.3)}`));
  await record.append(user("third"));
  await record.append(reply(`c1 ${filler(0.2)}`));
  await record.append(reply(`c2 ${filler(0.2)}`));
  await record.append(user("go on"));
  await record.append(ranWith("z", "a screen", [picture("t", 300_000)]));
  const said = pictured((await record.input()).items);
  assert.match(
    said[1] ?? "",
    /^\(Left out: all that was said and done after \[1\] and before \[5\]/,
  );
  assert.equal(said.at(-1), "a screen t");
});

/** A reply sent to the message `id`, which answers it. */
const sentTo = (id: string, text: string) => ({
  role: "assistant" as const,
  closes: id,
  items: [
    {
      type: "function_call" as const,
      callId: `send-${id}`,
      name: "send",
      arguments: JSON.stringify({ message: 0, text }),
    },
    { type: "function_call_output" as const, callId: `send-${id}`, output: "Sent." },
  ],
});
/** A compaction of what the record holds up to the place `upTo`. */
const compaction = (upTo: number, summary = "S", read?: string[], changed?: string[]) => ({
  role: "tool" as const,
  text: COMPACTION_LINE,
  items: [],
  compacted: { summary, upTo, ...(read ? { read } : {}), ...(changed ? { changed } : {}) },
});

test("after a compaction, its summary is sent in place of what it covers, after the opening message and what it covers still to answer, sent as it is", async () => {
  const record = single(store().calls as never);
  const task = await record.append(user("the task")); // 1
  await record.append(ran("a1", "read a")); // 2
  await record.append(sentTo(task.id, "did a")); // 3
  const b = await record.append(user("and b")); // 4
  await record.append(ran("b1", "read b")); // 5
  await record.append(sentTo(b.id, "did b")); // 6
  await record.append(user("and c")); // 7, still to answer
  await record.append(ran("c1", "read c")); // 8
  await record.append(compaction(8, "## Goal\n- The task.", ["a.ts"], ["b.ts"])); // 9
  await record.append(ran("c2", "read more")); // 10
  const { items, over } = await record.input();
  assert.equal(over, false);
  assert.deepEqual(await sent(record), [
    "the task",
    "and c",
    "The conversation history before this poi",
    "call c2",
    "output c2",
  ]);
  // The summary in its words, with the files read and changed.
  assert.deepEqual(items[2], {
    type: "message",
    role: "user",
    content:
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\n- The task.\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>\n</summary>",
  });
  // Over the budget, the summary stays with what is sent before it, as what was left out after it.
  for (const name of ["d", "e", "f"]) {
    await record.append(user(name));
    await record.append(reply(`${name}1 ${filler(0.45)}`));
  }
  await record.append(user("go on"));
  const fitted = await record.input();
  assert.equal(fitted.over, true);
  assert.deepEqual(
    (await sent(record)).map((one) => one.slice(0, 12)),
    ["the task", "and c", "The conversa", "(Left out: a", "f", "f1 xxxxxxxxx", "go on"],
  );
});

test("a compaction is made only for what it takes out of the request: not the opening message, nor what is still to answer", async () => {
  const record = single(store().calls as never);
  await record.append(user(`the task ${filler(0.3)}`)); // 1, sent whatever is summarized
  for (let i = 0; i < 3; i++) await record.append(ran(`a${i}`, filler(0.1)));
  // The opening message and one call would go: under a step of the budget, so only a refusal
  // for length summarizes it.
  assert.equal(await record.toCompact(), undefined);
  assert.equal((await record.toCompact(true))?.upTo, 2);
  // With only the opening message to go, nothing would be taken out: no summary at all.
  const opening = single(store().calls as never);
  await opening.append(user(`the task ${filler(0.3)}`));
  for (let i = 0; i < 2; i++) await opening.append(ran(`a${i}`, filler(0.1)));
  assert.equal(await opening.toCompact(true), undefined);
});

test("a compaction takes all since the one before but the newest bytes, cut between entries, and the exchange it cuts inside apart", async () => {
  const record = single(store().calls as never);
  await record.append(user("the task")); // 1
  for (let i = 0; i < 4; i++) await record.append(ran(`a${i}`, filler(0.1))); // 2-5
  await record.append(reply("did a")); // 6
  await record.append(user("go on")); // 7
  for (let i = 0; i < 4; i++) await record.append(ran(`b${i}`, filler(0.1))); // 8-11
  // The newest two calls are over 80,000 bytes: they stay, and the rest is summarized, the
  // exchange the cut falls in apart from what came before it.
  const first = await record.toCompact();
  assert.ok(first);
  assert.equal(first.upTo, 9);
  assert.equal(first.previous, undefined);
  const said = (items: Item[]) =>
    items.map((item) =>
      item.type === "message"
        ? item.content
        : item.type === "function_call"
          ? `call ${item.callId}`
          : `output ${item.callId}`,
    );
  assert.deepEqual(said(first.history), [
    "[1] the task",
    ...["a0", "a1", "a2", "a3"].flatMap((call) => [`call ${call}`, `output ${call}`]),
    "did a",
  ]);
  assert.deepEqual(said(first.prefix), [
    "[7] go on",
    ...["b0", "b1"].flatMap((call) => [`call ${call}`, `output ${call}`]),
  ]);
  await record.append(compaction(first.upTo));
  // Nothing again right after: what stays is all there is since.
  assert.equal(await record.toCompact(), undefined);
  assert.equal(await record.toCompact(true), undefined);
  // A little more is done: under a step of the budget is left to the cut, unless a request was
  // refused for its length.
  await record.append(ran("b4", filler(0.1)));
  assert.equal(await record.toCompact(), undefined);
  const forced = await record.toCompact(true);
  assert.ok(forced);
  assert.deepEqual(said(forced.history), ["call b2", "output b2"]);
  assert.deepEqual(forced.prefix, []);
  assert.equal(forced.previous?.summary, "S");
});

test("a call's arguments past their cap stay JSON, with their short values whole and their longest strings cut, saying so", async () => {
  const record = single(store().calls as never);
  await record.append(user("the task"));
  /** What is kept of a call given `args`. */
  const stored = async (args: string, id: string) => {
    const entry = await record.append(ran(id, "done", args));
    const call = entry.items.find((item) => item.type === "function_call");
    return call?.type === "function_call" ? call.arguments : "";
  };
  const bytes = (text: string) => new TextEncoder().encode(JSON.stringify(text)).byteLength;
  // A file written whole: its path and mode stay, and its text is cut to fit. The longest goes
  // first, so a shorter long string stays whole: cutting the longest is enough.
  const big = await stored(
    JSON.stringify({
      path: "src/app.ts",
      mode: "w",
      text: "y".repeat(60_000),
      note: "n".repeat(3_000),
      lines: [1, 2, 3],
    }),
    "w1",
  );
  assert.ok(bytes(big) <= 16 * 1024 && bytes(big) > 15 * 1024, `${bytes(big)}`);
  const kept = JSON.parse(big) as {
    path: string;
    mode: string;
    text: string;
    note: string;
    lines: number[];
  };
  assert.equal(kept.path, "src/app.ts");
  assert.equal(kept.mode, "w");
  assert.deepEqual(kept.lines, [1, 2, 3]);
  assert.match(kept.text, /^y+… \(\d+ more characters\)$/);
  assert.equal(kept.note, "n".repeat(3_000));
  // Escapes count as they are kept: quotes and line breaks take their written room.
  const quoted = await stored(JSON.stringify({ path: "q.txt", text: '"\n'.repeat(20_000) }), "w2");
  assert.ok(bytes(quoted) <= 16 * 1024 && bytes(quoted) > 15 * 1024, `${bytes(quoted)}`);
  assert.equal((JSON.parse(quoted) as { path: string }).path, "q.txt");
  // Arguments that aren't JSON, or that are over with every string cut, are a note.
  const many = Object.fromEntries(
    Array.from({ length: 400 }, (_, i) => [`k${i}`, "v".repeat(100)]),
  );
  for (const [args, id] of [
    [`{${"z".repeat(20_000)}`, "w3"],
    [JSON.stringify(many), "w4"],
  ] as const)
    assert.equal(await stored(args, id), '{"left_out":"too large to keep"}');
});

test("long strings are cut to one length, as long as fits, so short values stay whole; and a text cut twice counts all it left out", () => {
  const sized = (json: string) => json.length;
  // Two long strings end alike, and a long path beside them stays whole.
  const path = `/Users/someone/work/${"deep/".repeat(20)}file.ts`;
  const both = JSON.parse(
    cutInside(
      JSON.stringify({ path, a: "a".repeat(20_000), b: "b".repeat(19_000) }),
      10_000,
      sized,
    ) ?? "{}",
  ) as { path: string; a: string; b: string };
  assert.equal(both.path, path);
  assert.ok(Math.abs(both.a.length - both.b.length) <= 2, `${both.a.length} ${both.b.length}`);
  // Many strings each longer than the path: they are cut, to a length still above it.
  const many = JSON.parse(
    cutInside(
      JSON.stringify({ path, lines: Array.from({ length: 50 }, () => "l".repeat(400)) }),
      16_000,
      sized,
    ) ?? "{}",
  ) as { path: string; lines: string[] };
  assert.equal(many.path, path);
  assert.ok(many.lines.every((line) => line.length < 400 && line.length > path.length));
  // Too deep to walk is no JSON to cut.
  assert.equal(cutInside(`${"[".repeat(100_000)}${"]".repeat(100_000)}`, 1_000, sized), undefined);
  assert.equal(cut(cut("x".repeat(100), 50), 20), `${"x".repeat(20)}… (80 more characters)`);
});

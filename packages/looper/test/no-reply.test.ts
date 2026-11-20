import assert from "node:assert/strict";
import test from "node:test";
import {
  Entry,
  type Item,
  type OutputItem,
  type Picture,
  type Tool,
  textOf,
  type WorkEntry,
} from "../src/index.ts";
import { createRecord, createThread } from "../src/record.ts";
import { handsBack, held, kept, looperWith, newWork, says, sends, until } from "./support.ts";

type Made = ReturnType<typeof looperWith>;

/** A call of `no_reply_needed`: for the message of that number, or with none. */
const noReply = (message?: number): OutputItem[] => [
  {
    type: "function_call",
    callId: `quiet-${crypto.randomUUID()}`,
    name: "no_reply_needed",
    arguments: JSON.stringify(message === undefined ? {} : { message }),
  },
];
/** A worker calling `status` with `args`. */
const status = (args: unknown): OutputItem[] => [
  {
    type: "function_call",
    callId: `status-${crypto.randomUUID()}`,
    name: "status",
    arguments: JSON.stringify(args),
  },
];
/** The number the message `text` had in the latest request that read it. */
const numberOf = (made: Made, text: string) => {
  const line = made.numbered
    .findLast((lines) => lines.some((one) => one.endsWith(`] ${text}`)))
    ?.find((one) => one.endsWith(`] ${text}`));
  return Number(/^\[(\d+)\]/.exec(line ?? "")?.[1]);
};
/** Each fact said, as `thread: text fact`: the message named by its text, as the store keeps it. */
const facts = (made: Made) =>
  made.progress.map((line) => {
    const [, thread = "", id = "", fact = ""] = /^(.*): (\S+) (\S+)$/.exec(line) ?? [];
    const kept = made.values.get(`thread/${encodeURIComponent(thread)}/msg/${id}`);
    return `${thread}: ${kept === undefined ? id : textOf(Entry.parse(kept))} ${fact}`;
  });
/** The facts said of the message `text`. */
const of = (made: Made, text: string) => facts(made).filter((fact) => fact.includes(`: ${text} `));
/** What the calls of the latest request gave back, in order, as its next request was sent them. */
const outputs = (made: Made) =>
  (made.inputs.at(-1) ?? []).flatMap((line) =>
    line.startsWith("output ") ? [line.slice("output ".length)] : [],
  );
/** A refusal's words, from the output that carries it, or the output itself. */
const words = (output: string) =>
  output.startsWith('{"error"')
    ? (JSON.parse(output) as { error: { message: string } }).error.message
    : output;
/**
 * Wait until nothing is at work, then for all to be written: a turn that goes on instead of
 * ending waits for an answer that never comes, and fails this.
 */
const rested = async (made: Made) => {
  await until(() => made.working.at(-1) === false, "the turn to end");
  await made.looper.settled();
};
/** A thread's messages as a page read now shows them, each with what became of it. */
const page = async (looper: Made["looper"], thread: string) =>
  (await looper.page(thread, undefined, 50)).messages.map(({ text, progress }) =>
    progress === undefined ? text : `${text} (${progress.state})`,
  );
/** Work in thread `a` that answered its first message, and has been thanked. */
async function thanked(options: Parameters<typeof looperWith>[0] = {}) {
  const made = looperWith(options);
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", sends("Done."));
  await rested(made);
  await made.looper.send("a", "Thanks!");
  await until(() => made.asked.length === 2, "the request that reads it");
  return made;
}

test("a worker's no_reply_needed closes the message, said once; nothing is said in its thread, and its turn's end says no 'not answered'", async () => {
  const made = await thanked();
  made.answer("Thanks!", noReply(numberOf(made, "Thanks!")));
  await rested(made);
  assert.deepEqual(made.said, [
    "a: user: Write the report.",
    "a: assistant: Done.",
    "a: user: Thanks!",
  ]);
  assert.deepEqual(made.deltas, []);
  assert.deepEqual(made.failures, []);
  assert.deepEqual(of(made, "Thanks!"), ["a: Thanks! taken", "a: Thanks! closed"]);
  // Nothing is kept on the message as unanswered.
  const message = [...made.values.values()].find(
    (value) => (value as { items?: { content?: string }[] }).items?.[0]?.content === "Thanks!",
  );
  assert.equal("unanswered" in (message as object), false);
});

test("the main loop's no_reply_needed closes what it decides on: no work starts, it is said closed and not answered, and it isn't decided on again", async () => {
  const made = looperWith({
    routing: (text) =>
      text === "Thanks!" ? noReply() : text === "Hello?" ? says("Hi there.") : newWork(),
  });
  await made.looper.send("a", "Thanks!");
  await rested(made);
  assert.deepEqual(made.said, ["a: user: Thanks!"]);
  assert.deepEqual(made.asked, []);
  assert.equal(made.values.has("work/a"), false);
  assert.deepEqual(facts(made), ["a: Thanks! taken", "a: Thanks! closed"]);
  assert.deepEqual(made.failures, []);
  // Its thread waits for its next message, not for the next start.
  assert.equal(made.values.get("unrouted/a"), false);
  // The next decision is about the next message only: the closed one is not taken or answered.
  await made.looper.send("a", "Hello?");
  await until(() => made.said.includes("a: assistant: Hi there."), "the main loop's answer");
  await rested(made);
  assert.deepEqual(facts(made), [
    "a: Thanks! taken",
    "a: Thanks! closed",
    "a: Hello? taken",
    "a: Hello? answered",
  ]);
  // It reads what it did with the closed one: its call, and what it was told.
  assert.deepEqual(made.mains[1]?.input, [
    "There is no work.",
    "Thanks!",
    "function_call",
    "function_call_output",
    "Hello?",
  ]);
  assert.deepEqual(
    made.mainRaw[1]?.slice(2, 4).map((item) => {
      const { callId: _, ...rest } = item as { callId: string };
      return rest;
    }),
    [
      { type: "function_call", name: "no_reply_needed", arguments: "{}" },
      { type: "function_call_output", output: "Closed, with nothing said." },
    ],
  );
});

test("the main loop's no_reply_needed closes a message every piece of work handed back, and leaves its thread with nothing waiting", async () => {
  // Closed the first time it is put; were it put again, it would be answered, which shows.
  let back = 0;
  const made = looperWith({
    routing: (text) =>
      text.startsWith("That was given to this work")
        ? ++back === 1
          ? noReply()
          : says("Put again.")
        : newWork("The report"),
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", sends("Done."));
  await rested(made);
  await made.looper.send("a", "Ok, cheers.");
  await until(() => made.asked.length === 2, "the request that reads it");
  made.answer("Ok, cheers.", handsBack(numberOf(made, "Ok, cheers.")));
  await until(() => of(made, "Ok, cheers.").length >= 2, "the close");
  await until(() => made.working.at(-1) === false, "the loop to be idle");
  assert.equal(back, 1);
  assert.equal(made.mains.length, 2);
  assert.equal(made.asked.length, 2);
  assert.deepEqual(made.said.at(-1), "a: user: Ok, cheers.");
  assert.deepEqual(of(made, "Ok, cheers."), ["a: Ok, cheers. taken", "a: Ok, cheers. closed"]);
  assert.deepEqual(made.failures, []);
  await made.looper.settled();
  assert.equal(made.values.has("unrouted/a"), false);
});

test("each no_reply_needed that can't close is refused to the model in its words", async () => {
  const made = await thanked();
  const thanks = numberOf(made, "Thanks!");
  made.answer("Thanks!", [
    // Answered already.
    ...noReply(1),
    ...noReply(thanks),
    // Closed already, by the call before.
    ...noReply(thanks),
    // Not this work's.
    ...noReply(99),
    // No number.
    ...noReply(),
  ]);
  await until(() => made.asked.length === 3, "the request that reads what they came to");
  assert.deepEqual(outputs(made).map(words), [
    "Message [1] is already answered: it needs nothing more.",
    "Closed, with nothing said.",
    `Message [${thanks}] is already closed: it needs nothing more.`,
    "There is no message [99] of this work to close: check its number, and that it wasn't handed back.",
    "Give the number of the message that needs no reply.",
  ]);
  made.answer("Thanks!", []);
  await rested(made);
  // Handed back: not this work's to close.
  await made.looper.send("a", "What is the weather?");
  await until(() => made.asked.length === 4, "the request that reads it");
  const weather = numberOf(made, "What is the weather?");
  made.answer("What is the weather?", [...handsBack(weather), ...noReply(weather)]);
  await until(() => made.asked.length === 6, "the report's next request, and the weather's");
  const report = made.inputs.findLast((lines) => lines[0] === "Write the report.") ?? [];
  assert.equal(
    words(report.findLast((line) => line.startsWith("output "))?.slice("output ".length) ?? ""),
    `There is no message [${weather}] of this work to close: check its number, and that it wasn't handed back.`,
  );
  made.answer("What is the weather?", [], "Write the report.");
  made.answer("What is the weather?", sends("Sunny."), "What is the weather?");
  await rested(made);
  assert.deepEqual(of(made, "Thanks!"), ["a: Thanks! taken", "a: Thanks! closed"]);
  assert.deepEqual(of(made, "Write the report."), [
    "a: Write the report. taken",
    "a: Write the report. answered",
  ]);
  assert.deepEqual(made.failures, []);
});

test("a response of sends and no_reply_needed ends the turn as one of sends does, and so does one of no_reply_needed alone; one of status alone goes on", async () => {
  const { tool, calls, finish } = held();
  const made = looperWith({ askAfterSend: true, tools: [tool] });
  // Two messages read in one request: one answered, one closed with no reply.
  await made.looper.send("a", "Look it up.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Look it up.", calls(1));
  await until(() => made.looper.state("a").state === "tool", "the call to run");
  await made.looper.send("a", "Thanks!");
  finish();
  await until(() => made.asked.length === 2, "the request that reads both");
  made.answer("Thanks!", [
    ...sends("Found it.", numberOf(made, "Look it up.")),
    ...noReply(numberOf(made, "Thanks!")),
  ]);
  await rested(made);
  assert.equal(made.asked.length, 2);
  // Only a close, with nothing left: the turn ends there too.
  await made.looper.send("a", "Great, cheers.");
  await until(() => made.asked.length === 3, "the request");
  made.answer("Great, cheers.", noReply(numberOf(made, "Great, cheers.")));
  await rested(made);
  assert.equal(made.asked.length, 3);
  // Its steps alone go on; then a close beside its steps ends it.
  await made.looper.send("a", "Ta.");
  await until(() => made.asked.length === 4, "the request");
  made.answer("Ta.", status({ steps: [{ text: "Read it" }] }));
  await until(() => made.asked.length === 5, "the request after its steps alone");
  made.answer("Ta.", [...status({ advance: true }), ...noReply(numberOf(made, "Ta."))]);
  await rested(made);
  assert.equal(made.asked.length, 5);
  assert.deepEqual(made.failures, []);
  assert.deepEqual(made.said, [
    "a: user: Look it up.",
    "a: user: Thanks!",
    "a: assistant: Found it.",
    "a: user: Great, cheers.",
    "a: user: Ta.",
  ]);
});

test("a no_reply_needed is no Activity entry, refused or not, and the model reads the call and its output in its next request", async () => {
  const note: Tool = {
    name: "note",
    parameters: {},
    run: async () => ({ output: "Noted.", ok: true }),
  };
  const made = await thanked({ tools: [note] });
  const thanks = numberOf(made, "Thanks!");
  made.answer("Thanks!", [
    ...noReply(99),
    ...noReply(thanks),
    { type: "function_call", callId: "n1", name: "note", arguments: "{}" },
  ]);
  await until(() => made.asked.length === 3, "the request after them");
  made.answer("Thanks!", []);
  await rested(made);
  const { entries } = await made.looper.entries("a", undefined, 10);
  assert.deepEqual(
    entries.map((one: WorkEntry) => ("call" in one ? one.call.name : JSON.stringify(one))),
    ["note"],
  );
  // The next turn reads both calls with their outputs, where they were made.
  await made.looper.send("a", "One more thing.");
  await until(() => made.asked.length === 4, "the next turn's request");
  assert.deepEqual(
    made.raw[3]?.slice(-8, -1).map((item) => {
      const { callId: _, ...rest } = item as { callId?: string };
      return rest;
    }),
    [
      { type: "message", role: "user", content: `[${thanks}] Thanks!` },
      { type: "function_call", name: "no_reply_needed", arguments: '{"message":99}' },
      {
        type: "function_call_output",
        output: JSON.stringify({
          error: {
            code: "invalid",
            message:
              "There is no message [99] of this work to close: check its number, and that it wasn't handed back.",
          },
        }),
      },
      {
        type: "function_call",
        name: "no_reply_needed",
        arguments: JSON.stringify({ message: thanks }),
      },
      { type: "function_call_output", output: "Closed, with nothing said." },
      { type: "function_call", name: "note", arguments: "{}" },
      { type: "function_call_output", output: "Noted." },
    ],
  );
  made.answer("One more thing.", sends("Sure."));
  await rested(made);
});

test("a page read later, by this looper or the next, shows the message closed, and no problem", async () => {
  const made = await thanked();
  made.answer("Thanks!", noReply(numberOf(made, "Thanks!")));
  await rested(made);
  const again = looperWith({ values: made.values });
  for (const looper of [made.looper, again.looper])
    assert.deepEqual(await page(looper, "a"), [
      "Write the report. (answered)",
      "Done.",
      "Thanks! (closed)",
    ]);
  assert.deepEqual(made.failures, []);
});

test("a message an earlier stop closed can still be settled with no reply: no new fact is said, and that turn ends with no 'not answered'", async () => {
  const made = looperWith({ askAfterSend: true });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  await made.looper.cancel("a");
  await made.looper.settled();
  assert.deepEqual(facts(made), ["a: Write the report. taken", "a: Write the report. closed"]);
  const stopped = /^a: (\S+) /.exec(made.progress[0] ?? "")?.[1];
  await made.looper.send("a", "Never mind, thanks.");
  await until(() => made.asked.length === 2, "the next turn's request");
  made.answer("Never mind, thanks.", [
    ...noReply(numberOf(made, "Write the report.")),
    ...noReply(numberOf(made, "Never mind, thanks.")),
  ]);
  // Both settled: the turn ends there, asking nothing more.
  await rested(made);
  assert.equal(made.asked.length, 2);
  assert.deepEqual(facts(made), [
    "a: Write the report. taken",
    "a: Write the report. closed",
    "a: Never mind, thanks. taken",
    "a: Never mind, thanks. closed",
  ]);
  assert.deepEqual(made.failures, []);
  // A line now closes it, so nothing holds it open.
  assert.ok(
    [...made.values.values()].some(
      (value) => (value as { closes?: string; role?: string }).closes === stopped,
    ),
  );
  // Settled now: a second close is refused.
  await made.looper.send("a", "Bye.");
  await until(() => made.asked.length === 3, "the request");
  made.answer("Bye.", noReply(numberOf(made, "Write the report.")));
  await until(() => made.asked.length === 4, "the request that reads the refusal");
  assert.equal(
    words(outputs(made).at(-1) ?? ""),
    `Message [${numberOf(made, "Write the report.")}] is already closed: it needs nothing more.`,
  );
  made.answer("Bye.", noReply(numberOf(made, "Bye.")));
  await rested(made);
});

test("a close line is no call the thread's cap deletes: past the cap its message stays settled, and its pictures go as an answered message's do", async () => {
  const values = new Map<string, unknown>();
  const store = {
    get: async ({ key }: { key: string }) =>
      values.has(key) ? { value: values.get(key) as never } : {},
    set: async ({ key, value }: { key: string; value: unknown }) => void values.set(key, value),
    delete: async ({ key }: { key: string }) => ({ deleted: values.delete(key) }),
    list: async ({ prefix = "", after }: { prefix?: string; after?: string }) => ({
      keys: [...values.keys()]
        .filter((k) => k.startsWith(prefix) && (after === undefined || k > after))
        .sort(),
      next: null,
    }),
  };
  const log = { info() {}, warn() {}, error() {} };
  const made = () => {
    const thread = createThread(store as never, log, { keep: 2, keepBytes: 2_000 });
    return createRecord({
      id: "t",
      follows: () => ["t"],
      thread: () => thread,
      waits: () => true,
      left: () => false,
    });
  };
  const picture = (data: string): Picture => ({ mediaType: "image/png", data });
  const said = (content: string, images: Picture[]) => ({
    role: "user" as const,
    items: [{ type: "message" as const, role: "user" as const, content, images }],
  });
  const ran = (callId: string, name: string, output: string): Item[] => [
    { type: "function_call", callId, name, arguments: "{}" },
    { type: "function_call_output", callId, output },
  ];
  const record = made();
  await record.append(said("Thanks!", [picture("A".repeat(1_200))]), { thread: "t" });
  assert.equal(
    typeof (await record.closeQuietly(1, ran("q", "no_reply_needed", "Closed."), {})),
    "object",
  );
  // More calls than the cap keeps.
  for (const id of ["c1", "c2", "c3", "c4"])
    await record.append(
      { role: "tool", text: "look: done", items: ran(id, "look", "seen") },
      {
        thread: "t",
      },
    );
  // Past the pictures' bytes: the closed message's goes, as an answered one's does.
  await record.append(said("And this.", [picture("B".repeat(1_200))]), { thread: "t" });
  // Still settled, here and as stored: a second close is refused.
  for (const one of [record, made()])
    assert.equal(await one.closeQuietly(1, ran("r", "no_reply_needed", "Closed."), {}), "closed");
  const first = [...values.values()].find((value) =>
    (value as { items?: { content?: string }[] }).items?.[0]?.content?.startsWith("Thanks!"),
  ) as { items: { content: string; images?: Picture[] }[] };
  assert.equal(first.items[0]?.content, "Thanks!\n(A picture, left out.)");
  assert.equal(first.items[0]?.images, undefined);
});

test("a worker's close the store refuses is no close: it isn't said, the turn fails as a refused reply fails it, and the record holds no line", async () => {
  let refusing = true;
  const made = await thanked({
    writing: (key) => {
      if (key !== "thread/a/msg/000000000004" || !refusing) return undefined;
      refusing = false;
      return Promise.reject(new Error("the store refused it"));
    },
  });
  made.answer("Thanks!", noReply(numberOf(made, "Thanks!")));
  await rested(made);
  assert.deepEqual(made.failures, ["a: failed"]);
  assert.equal(made.asked.length, 2);
  assert.ok(!kept(made.values, "a").includes("no_reply_needed: done"));
  // Nothing closes it here either: a later close is taken, with no new fact.
  const before = made.progress.length;
  await made.looper.send("a", "Bye.");
  await until(() => made.asked.length === 3, "the next turn's request");
  made.answer("Bye.", [...noReply(numberOf(made, "Thanks!")), ...noReply(numberOf(made, "Bye."))]);
  await rested(made);
  assert.equal(made.asked.length, 3);
  assert.deepEqual(
    made.progress.slice(before).map((line) => line.split(" ").at(-1)),
    ["taken", "closed"],
  );
});

test("a main loop's close the store refuses fails the decision, as an answer that can't be kept does: nothing is said closed", async () => {
  const made = looperWith({
    routing: () => noReply(),
    writing: (key) =>
      key === "thread/b/msg/000000000002"
        ? Promise.reject(new Error("the store refused it"))
        : undefined,
  });
  await made.looper.send("b", "Thanks!");
  await until(() => made.failures.length === 1, "the decision to fail");
  await rested(made);
  assert.deepEqual(made.failures, ["b: failed"]);
  assert.deepEqual(facts(made), ["b: Thanks! taken"]);
  assert.deepEqual(kept(made.values, "b"), ["Thanks!"]);
});

test("the main loop's text beside its close is its answer: the message is answered, not closed", async () => {
  const made = looperWith({ routing: () => [...says("You're welcome!"), ...noReply()] });
  await made.looper.send("a", "Thanks!");
  await until(() => made.said.includes("a: assistant: You're welcome!"), "the answer");
  await rested(made);
  assert.deepEqual(facts(made), ["a: Thanks! taken", "a: Thanks! answered"]);
  assert.deepEqual(kept(made.values, "a"), ["Thanks!", "You're welcome!"]);
});

test("the main loop's route beside its close wins: the work takes the message, and nothing is closed", async () => {
  const made = looperWith({ routing: () => [...noReply(), ...newWork("The report")] });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the work's request");
  assert.deepEqual(facts(made), ["a: Write the report. taken"]);
  made.answer("Write the report.", sends("Done."));
  await rested(made);
  assert.deepEqual(facts(made), ["a: Write the report. taken", "a: Write the report. answered"]);
  assert.ok(!kept(made.values, "a").includes("no_reply_needed: done"));
});

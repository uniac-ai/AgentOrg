import assert from "node:assert/strict";
import test from "node:test";
import { COMPACTION_LINE, SUMMARY_BEGINS } from "../src/compaction.ts";
import { type Item, type OutputItem, Refusal, type Tool, type WorkEntry } from "../src/index.ts";
import { HAND_BACK, NO_REPLY, SEND, STATUS } from "../src/loop.ts";
import { INPUT_BUDGET, REQUEST_BUDGET } from "../src/record.ts";
import { type Given, handsBack, idle, looperWith, says, sends, until } from "./support.ts";

/** A tool that reads a file: each output is 25,000 characters, so twenty are over the least room. */
const look: Tool = {
  name: "look",
  parameters: {},
  run: async () => ({ output: "x".repeat(25_000), ok: true }),
};
const write: Tool = {
  name: "write",
  parameters: {},
  run: async () => ({ output: "Written.", ok: true }),
};
/** Calls of `look`, one for each file from `f<from>.ts` on. */
const looks = (from: number, count: number): OutputItem[] =>
  Array.from({ length: count }, (_, i) => ({
    type: "function_call",
    callId: `look-${from + i}`,
    name: "look",
    arguments: JSON.stringify({ path: `f${from + i}.ts` }),
  }));
/** What the host says each call read or changed. */
const files = (call: { name: string; arguments: string }) => {
  const { path } = JSON.parse(call.arguments) as { path: string };
  return call.name === "write" ? { changed: [path] } : { read: [path] };
};
const shown = (entry: WorkEntry) =>
  "call" in entry ? `${entry.call.name} ${entry.call.state}` : "line" in entry ? entry.line : "";
/** Each item a request held: a message by its first words, and a call's parts by the call. */
const items = (input: unknown[]) =>
  (input as Item[]).map((item) =>
    item.type === "message" ? item.content.slice(0, 30) : `${item.type} ${item.callId}`,
  );
/**
 * What the host tells a worker, long enough that its requests' words have only the least room,
 * `INPUT_BUDGET`: so twenty calls of `look` are over it.
 */
const FLOOR = "x".repeat(REQUEST_BUDGET - INPUT_BUDGET);
/** A summary's first words, as `items` gives them. */
const SUMMARY = SUMMARY_BEGINS.slice(0, 30);
/** The words of the message at `at` among a request's items. */
const contentOf = (input: unknown[] | undefined, at: number) =>
  ((input ?? [])[at] as { content: string }).content;
/** What a summary was given to summarize, oldest first. */
const summarized = (one: Given | undefined) => [
  ...(one?.compacting.history ?? []),
  ...(one?.compacting.prefix ?? []),
];
/** The paths its calls name. */
const pathsOf = (summarized: Item[]) =>
  summarized.flatMap((item) =>
    item.type === "function_call" ? [(JSON.parse(item.arguments) as { path: string }).path] : [],
  );

test("past the budget, a work's earlier steps are summarized once by its own model, and it is sent the opening message, the summary and its latest steps", async () => {
  const { looper, asked, raw, summaries, given, answer, lives } = looperWith({
    tools: [look],
    instructions: FLOOR,
  });
  await looper.send("a", "Read every file.");
  await until(() => asked.length === 1, "the request");
  answer("Read every file.", looks(0, 20));
  await until(() => asked.length === 2, "the request after the calls");
  // One request for a summary, with no tools, of the exchange the cut falls in: the opening
  // message and the calls before the newest four, which stay.
  assert.equal(summaries.length, 1);
  assert.equal(given.length, 1);
  assert.deepEqual(items(summarized(given[0])), [
    "[1] Read every file.",
    ...Array.from({ length: 16 }, (_, i) => [
      `function_call look-${i}`,
      `function_call_output look-${i}`,
    ]).flat(),
  ]);
  assert.deepEqual(items(raw[1] ?? []), [
    "[1] Read every file.",
    SUMMARY,
    ...[16, 17, 18, 19].flatMap((i) => [
      `function_call look-${i}`,
      `function_call_output look-${i}`,
    ]),
  ]);
  assert.match(contentOf(raw[1], 1), /<summary>\n## Goal\n- Summary 1\.\n<\/summary>$/);
  // Its Activity says so, once.
  const { entries } = await looper.entries("a", undefined, 30);
  assert.deepEqual(entries.map(shown).slice(-2), ["look done", COMPACTION_LINE]);
  // Under the budget again, the next request asks for no summary.
  answer(asked[1] as string, looks(20, 1));
  await until(() => asked.length === 3, "the request after one more");
  assert.equal(summaries.length, 1);
  answer(asked[2] as string, sends("Read them all."));
  await looper.settled();
  assert.equal(looper.state("a").state, "idle");
  // Whoever follows the work's life hears its turn start, its summary before and after, and its end.
  assert.deepEqual(
    lives.map((line) => line.split(": ")[1]),
    ["turnStarted", "compacting", "compacted", "turnEnded"],
  );
});

test("each later summary updates the one before, and the files read and changed are carried", async () => {
  const { looper, asked, raw, summaries, given, answer } = looperWith({
    tools: [look, write],
    files,
    instructions: FLOOR,
  });
  await looper.send("a", "Read every file.");
  await until(() => asked.length === 1, "the request");
  answer("Read every file.", [
    { type: "function_call", callId: "w", name: "write", arguments: '{"path":"f3.ts"}' },
    ...looks(0, 19),
  ]);
  await until(() => asked.length === 2, "the request after the calls");
  answer(asked[1] as string, looks(19, 16));
  await until(() => asked.length === 3, "the request after more");
  assert.equal(summaries.length, 2);
  // The second summary is given the first, as the record keeps it, and the host's files; it
  // summarizes the calls since the first, but for the newest four.
  const [first, second] = given;
  assert.equal(given.length, 2);
  assert.deepEqual(second?.compacting.previous, first?.compacted);
  assert.equal(second?.files, files);
  assert.deepEqual(
    pathsOf(summarized(second)),
    Array.from({ length: 16 }, (_, i) => `f${15 + i}.ts`),
  );
  // Each summary is sent with the lists of files its summarizer gave back.
  const paths = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `f${from + i}.ts`).join("\n");
  assert.equal(
    contentOf(raw[1], 1),
    `${SUMMARY_BEGINS}:\n\n<summary>\n## Goal\n- Summary 1.\n\n<read-files>\n${paths(0, 14)}\n</read-files>\n\n<modified-files>\nf3.ts\n</modified-files>\n</summary>`,
  );
  assert.equal(
    contentOf(raw[2], 1),
    `${SUMMARY_BEGINS}:\n\n<summary>\n## Goal\n- Summary 2.\n\n<read-files>\n${paths(15, 30)}\n</read-files>\n</summary>`,
  );
  answer(asked[2] as string, sends("Read them all."));
  await looper.settled();
});

test("when summarizing fails, the oldest are cut as before, and the turn doesn't ask again", async () => {
  const { looper, asked, raw, summaries, answer } = looperWith({
    tools: [look],
    instructions: FLOOR,
    summarizing: () => Promise.reject(new Error("The model is down.")),
  });
  await looper.send("a", "Read every file.");
  await until(() => asked.length === 1, "the request");
  answer("Read every file.", looks(0, 20));
  await until(() => asked.length === 2, "the request after the calls");
  assert.equal(summaries.length, 1);
  const leftOut = (input: unknown[]) =>
    (input as Item[]).filter(
      (item) => item.type === "function_call_output" && item.output.startsWith("(Left out"),
    ).length;
  assert.ok(leftOut(raw[1] ?? []) > 0);
  answer("Read every file.", looks(20, 4));
  await until(() => asked.length === 3, "the request after more");
  assert.equal(summaries.length, 1);
  answer("Read every file.", sends("Read most."));
  await looper.settled();
  const { entries } = await looper.entries("a", undefined, 30);
  assert.ok(!entries.map(shown).includes(COMPACTION_LINE));
  // The next turn tries again, once it has done something of its own: the request that only
  // decides whether to take the message is cut as before.
  await looper.send("a", "Go on.");
  await until(() => asked.length === 4, "the next turn's request");
  assert.equal(summaries.length, 1);
  answer("Go on.", looks(24, 1));
  await until(() => asked.length === 5, "the request after its call");
  assert.equal(summaries.length, 2);
  answer("Go on.", sends("Still down."));
  await looper.settled();
});

test("a request the model refuses for its length is asked again once after a summary; refused again, the turn fails", async () => {
  const { looper, asked, raw, summaries, answer, fail, failures } = looperWith({
    tools: [look],
    instructions: FLOOR,
  });
  await looper.send("a", "Read every file.");
  await until(() => asked.length === 1, "the request");
  // Under the budget: nothing is summarized until the model refuses.
  answer("Read every file.", looks(0, 8));
  await until(() => asked.length === 2, "the request after the calls");
  assert.equal(summaries.length, 0);
  const tooLong = () => new Refusal("context_length", "The request is too long for the model.");
  fail("Read every file.", tooLong());
  await until(() => asked.length === 3, "the request asked again");
  assert.equal(summaries.length, 1);
  assert.deepEqual(items(raw[2] ?? []).slice(0, 3), [
    "[1] Read every file.",
    SUMMARY,
    "function_call look-4",
  ]);
  fail(asked[2] as string, tooLong());
  await looper.settled();
  assert.equal(summaries.length, 1);
  assert.deepEqual(failures, ["a: context_length"]);
  assert.equal(looper.state("a").state, "error");
});

test("with no summarizer, nothing is summarized: the oldest are cut, the turn goes on, and the record keeps them all", async () => {
  const { looper, asked, raw, summaries, answer, lives, warnings, said } = looperWith({
    tools: [look],
    instructions: FLOOR,
    summarizer: () => undefined,
  });
  await looper.send("a", "Read every file.");
  await until(() => asked.length === 1, "the request");
  answer("Read every file.", looks(0, 20));
  await until(() => asked.length === 2, "the request after the calls");
  // No summary is asked for, and nothing warns of one: the request is cut to fit, and says so.
  assert.equal(summaries.length, 0);
  assert.deepEqual(warnings, []);
  assert.ok(
    (raw[1] as Item[]).some(
      (item) => item.type === "function_call_output" && item.output.startsWith("(Left out:"),
    ),
  );
  answer("Read every file.", sends("Read them all."));
  await looper.settled();
  assert.ok(said.includes("a: assistant: Read them all."));
  assert.equal(looper.state("a").state, "idle");
  const { entries } = await looper.entries("a", undefined, 30);
  assert.equal(entries.map(shown).filter((line) => line === "look done").length, 20);
  assert.ok(!entries.map(shown).includes(COMPACTION_LINE));
  assert.deepEqual(
    lives.map((line) => line.split(": ")[1]),
    ["turnStarted", "turnEnded"],
  );
});

test("a turn stopped while its steps are summarized keeps nothing of the summary", async () => {
  const { looper, asked, summaries, answer } = looperWith({
    tools: [look],
    instructions: FLOOR,
    summarizing: () => new Promise<OutputItem[]>(() => {}),
  });
  await looper.send("a", "Read every file.");
  await until(() => asked.length === 1, "the request");
  answer("Read every file.", looks(0, 20));
  await until(() => summaries.length === 1, "the summary request");
  await looper.stop();
  await idle();
  assert.equal(asked.length, 1);
  const { entries } = await looper.entries("a", undefined, 30);
  assert.ok(!entries.map(shown).includes(COMPACTION_LINE));
  assert.equal(looper.state("a").state, "idle");
});

test("a request that only decides whether to take a message makes no summary, though over the budget", async () => {
  const { looper, asked, numbered, summaries, answer } = looperWith({
    tools: [look],
    instructions: FLOOR,
    summarizing: () => Promise.reject(new Error("The model is down.")),
  });
  await looper.send("a", "Read every file.");
  await until(() => asked.length === 1, "the request");
  answer("Read every file.", looks(0, 20));
  await until(() => asked.length === 2, "the request after the calls");
  assert.equal(summaries.length, 1);
  answer("Read every file.", sends("Read most."));
  await looper.settled();
  // Its record is still over the budget: a message it hands back costs no summary.
  await looper.send("a", "What is the weather?");
  await until(() => asked.length === 3, "its request");
  const number = Number(/^\[(\d+)\]/.exec(numbered[2]?.at(-1) ?? "")?.[1]);
  // Words written beside the hand-back are not acting.
  answer("What is the weather?", [...says("Not mine."), ...handsBack(number, "Not this work's.")]);
  await until(() => asked.length === 4, "the new work's request");
  assert.deepEqual(numbered[3], ["[1] What is the weather?"]);
  assert.equal(summaries.length, 1);
  answer("What is the weather?", sends("Sunny."));
  await looper.settled();
});

test("a request is fitted to its budget with all it carries beside its input, its id and keys too", async () => {
  const output = "x".repeat(29_000);
  const big: Tool = { name: "big", parameters: {}, run: async () => ({ output, ok: true }) };
  const specs = [{ name: "big", parameters: {} }, SEND, HAND_BACK, STATUS, NO_REPLY];
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  /** Once its turn has ended and all it holds is written. */
  const rested = async (made: ReturnType<typeof looperWith>) => {
    await until(() => made.working.at(-1) === false, "the turn to end");
    await made.looper.settled();
  };
  /** A long first turn, then "Go on.", whose request is made with `pad` from the host. */
  const run = async (pad: string) => {
    let padded = false;
    const made = looperWith({ tools: [big], instructions: () => (padded ? pad : "") });
    await made.looper.send("a", "Read them all.");
    await until(() => made.asked.length === 1, "the request");
    made.answer(
      "Read them all.",
      Array.from({ length: 31 }, (_, i) => ({
        type: "function_call" as const,
        callId: `c${String(i).padStart(2, "0")}`,
        name: "big",
        arguments: "{}",
      })),
    );
    await until(() => made.asked.length === 2, "the request after the calls");
    made.answer("Read them all.", sends("Read."));
    await rested(made);
    padded = true;
    await made.looper.send("a", "Go on.");
    await until(() => made.asked.length === 3, "the next turn's request");
    return made;
  };
  const a = await run("");
  // Its two exchanges as they are fitted, and what is beside them but its id and keys.
  const input = bytes(a.raw[2]) + 1;
  const besides = bytes({ instructions: a.told[2]?.instructions, tools: specs });
  // The host's words, after a blank line, fill all but 25 bytes of the room: too few for the
  // request's id and keys.
  const b = await run("x".repeat(REQUEST_BUDGET - 25 - input - besides - 4));
  assert.ok(
    bytes({
      requestId: crypto.randomUUID(),
      instructions: b.told[2]?.instructions,
      input: b.raw[2],
      tools: specs,
    }) <= REQUEST_BUDGET,
  );
  assert.ok(b.inputs[2]?.some((line) => line.includes("(Left out:")));
  for (const made of [a, b]) {
    made.answer("Go on.", sends("Done."));
    await rested(made);
  }
});

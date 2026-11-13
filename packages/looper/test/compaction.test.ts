import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACTION_LINE,
  SUMMARY_BEGINS,
  SUMMARY_INPUT,
  serialize,
  summarize,
} from "../src/compaction.ts";
import { type Item, type OutputItem, Refusal, type Tool, type WorkEntry } from "../src/index.ts";
import { idle, looperWith, sends, until } from "./support.ts";

/** A tool that reads a file: each output is 25,000 characters, so twenty are over the budget. */
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
/** A summary's first words, as `items` gives them. */
const SUMMARY = SUMMARY_BEGINS.slice(0, 30);
/** The words of the message at `at` among a request's items. */
const contentOf = (input: unknown[] | undefined, at: number) =>
  ((input ?? [])[at] as { content: string }).content;

test("past the budget, a work's earlier steps are summarized once by its own model, and it is sent the opening message, the summary and its latest steps", async () => {
  const { looper, asked, raw, summaries, answer } = looperWith({ tools: [look] });
  await looper.send("a", "Read every file.");
  await until(() => asked.length === 1, "the request");
  answer("Read every file.", looks(0, 20));
  await until(() => asked.length === 2, "the request after the calls");
  // One request for a summary, with no tools, of the exchange the cut falls in: the opening
  // message and the calls before the newest four, which stay.
  assert.equal(summaries.length, 1);
  const [summary] = summaries;
  assert.match(summary?.instructions ?? "", /^You are a context summarization assistant\./);
  assert.match(
    summary?.text ?? "",
    /^# Conversation\n\[User\]: \[1\] Read every file\.\n\n\[Assistant tool calls\]: look\(path="f0\.ts"\)\n\n\[Tool result\]: x{2000}\n\n\[\.\.\. 23000 more characters truncated\]/,
  );
  assert.ok(summary?.text.includes('look(path="f15.ts")'));
  assert.ok(!summary?.text.includes('look(path="f16.ts")'));
  assert.ok(summary?.text.endsWith("Do not infer or recreate later messages."));
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
});

test("each later summary updates the one before, and the files read and changed are carried", async () => {
  const { looper, asked, raw, summaries, answer } = looperWith({ tools: [look, write], files });
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
  // The calls since the first, but for the newest four, and the summary before.
  const text = summaries[1]?.text ?? "";
  assert.match(text, /^<conversation>\n\[Assistant tool calls\]: look\(path="f15\.ts"\)/);
  assert.ok(text.includes('look(path="f30.ts")') && !text.includes('look(path="f31.ts")'));
  assert.ok(
    text.includes(
      "</conversation>\n\n<previous-summary>\n## Goal\n- Summary 1.\n</previous-summary>\n\nThe messages above are NEW conversation messages to incorporate",
    ),
  );
  assert.ok(text.endsWith("Preserve exact file paths, function names, and error messages."));
  const read = Array.from({ length: 31 }, (_, i) => `f${i}.ts`).filter((path) => path !== "f3.ts");
  assert.equal(
    contentOf(raw[2], 1),
    `${SUMMARY_BEGINS}:\n\n<summary>\n## Goal\n- Summary 2.\n\n<read-files>\n${read.join("\n")}\n</read-files>\n\n<modified-files>\nf3.ts\n</modified-files>\n</summary>`,
  );
  answer(asked[2] as string, sends("Read them all."));
  await looper.settled();
});

test("when summarizing fails, the oldest are cut as before, and the turn doesn't ask again", async () => {
  const { looper, asked, raw, summaries, answer } = looperWith({
    tools: [look],
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
  // The next turn tries again.
  await looper.send("a", "Go on.");
  await until(() => asked.length === 4, "the next turn's request");
  assert.equal(summaries.length, 2);
  answer("Go on.", sends("Still down."));
  await looper.settled();
});

test("a request the model refuses for its length is asked again once after a summary; refused again, the turn fails", async () => {
  const { looper, asked, raw, summaries, answer, fail, failures } = looperWith({ tools: [look] });
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

test("a turn stopped while its steps are summarized keeps nothing of the summary", async () => {
  const { looper, asked, summaries, answer } = looperWith({
    tools: [look],
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

/** A message of the person's, and a call that names a file. */
const said = (content: string): Item => ({ type: "message", role: "user", content });
const named = (name: string, path: string): Item => ({
  type: "function_call",
  callId: `${name}-${path}`,
  name,
  arguments: JSON.stringify({ path }),
});

test("a summary is asked for with the first or the update prompt for what came before, the turn-prefix prompt for an exchange cut inside, after it", async () => {
  const asks: string[] = [];
  const ask = async (_instructions: string, text: string) => {
    asks.push(text);
    return `summary ${asks.length}`;
  };
  const first = await summarize(
    ask,
    { history: [said("[1] the task"), named("look", "a.ts")], prefix: [], upTo: 2 },
    files,
  );
  assert.ok(
    asks[0]?.startsWith(
      '<conversation>\n[User]: [1] the task\n\n[Assistant tool calls]: look(path="a.ts")\n</conversation>\n\nThe messages above are a conversation to summarize.',
    ),
  );
  assert.ok(!asks[0]?.includes("<previous-summary>"));
  assert.deepEqual(first, { summary: "summary 1", upTo: 2, read: ["a.ts"] });
  const second = await summarize(
    ask,
    {
      history: [named("write", "a.ts")],
      prefix: [said("[3] go on"), named("look", "b.ts")],
      previous: first,
      upTo: 5,
    },
    files,
  );
  assert.match(
    asks[1] ?? "",
    /<previous-summary>\nsummary 1\n<\/previous-summary>\n\nThe messages above are NEW conversation messages/,
  );
  assert.ok(asks[2]?.startsWith("# Conversation\n[User]: [3] go on"));
  assert.ok(asks[2]?.includes("\n\n# Instructions\nThe messages above are earlier context"));
  // A file read and then changed is among those changed only.
  assert.deepEqual(second, {
    summary: "summary 2\n\n---\n\n**Turn Context (split turn):**\n\nsummary 3",
    upTo: 5,
    read: ["b.ts"],
    changed: ["a.ts"],
  });
});

test("a summary keeps 16,000 characters, the history giving way to the turn's part, and each file list its newest within 900", async () => {
  const answers = ["h".repeat(16_000), "the turn"];
  const ask = async () => answers.shift() as string;
  const paths = Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`);
  const result = await summarize(
    ask,
    {
      history: [...paths, "x".repeat(1_000)].map((path) => named("look", path)),
      prefix: [said("[9] go on")],
      upTo: 9,
    },
    files,
  );
  assert.equal(result.summary.length, 16_000);
  assert.ok(result.summary.startsWith("hhh"));
  assert.ok(result.summary.endsWith("\n\n---\n\n**Turn Context (split turn):**\n\nthe turn"));
  // A path too long for the list is left out, and the newest others stay.
  const read = result.read ?? [];
  assert.equal(read.at(-1), "src/file-199.ts");
  assert.ok(read.length > 1 && read.join("\n").length < 900);
  assert.ok(read.every((path) => path.length < 1_000));
});

test("a conversation is written out for a summary, each call's arguments and output cut, and the oldest left out past its bound, saying so", () => {
  assert.equal(
    serialize([
      said("[1] the task"),
      {
        type: "function_call",
        callId: "c1",
        name: "look",
        arguments: JSON.stringify({ path: "a.ts", text: "y".repeat(3_000) }),
      },
      { type: "function_call_output", callId: "c1", output: "x".repeat(2_500) },
      { type: "message", role: "assistant", content: "Read it." },
    ]),
    `[User]: [1] the task\n\n[Assistant tool calls]: look(path="a.ts", text="${"y".repeat(1_981)}\n\n[... 1020 more characters truncated])\n\n[Tool result]: ${"x".repeat(2_000)}\n\n[... 500 more characters truncated]\n\n[Assistant]: Read it.`,
  );
  const long = serialize(
    Array.from({ length: 200 }, (_, i) => said(`[${i}] ${"y".repeat(1_000)}`)),
  );
  assert.ok(long.length <= SUMMARY_INPUT);
  assert.match(
    long,
    /^\[\.\.\. \d+ earlier parts of the conversation left out\]\n\n\[User\]: \[\d+\] y/,
  );
  assert.ok(long.endsWith(`[199] ${"y".repeat(1_000)}`));
});

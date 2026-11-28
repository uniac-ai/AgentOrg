import assert from "node:assert/strict";
import test from "node:test";
import type { Item } from "@agentorg/looper";
import { SUMMARY_INPUT, serialize, summarize } from "../src/summarize.ts";

/** What the host says each call read or changed. */
const files = (call: { name: string; arguments: string }) => {
  const { path } = JSON.parse(call.arguments) as { path: string };
  return call.name === "write" ? { changed: [path] } : { read: [path] };
};

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
  const told: string[] = [];
  const ask = async (instructions: string, text: string) => {
    told.push(instructions);
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
  assert.ok(asks[1]?.endsWith("Preserve exact file paths, function names, and error messages."));
  assert.ok(asks[2]?.startsWith("# Conversation\n[User]: [3] go on"));
  assert.ok(asks[2]?.includes("\n\n# Instructions\nThe messages above are earlier context"));
  assert.ok(asks[2]?.endsWith("Do not infer or recreate later messages."));
  // Each is asked as pi's summarization assistant.
  assert.equal(told.length, 3);
  assert.ok(told.every((words) => /^You are a context summarization assistant\./.test(words)));
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

test("a conversation is written out for a summary, each call's arguments and output cut, in pieces that leave nothing out", () => {
  assert.deepEqual(
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
    [
      `[User]: [1] the task\n\n[Assistant tool calls]: look(path="a.ts", text="${"y".repeat(1_981)}\n\n[... 1020 more characters truncated])\n\n[Tool result]: ${"x".repeat(2_000)}\n\n[... 500 more characters truncated]\n\n[Assistant]: Read it.`,
    ],
  );
  // Past its bound, in pieces of whole parts, the oldest first.
  const long = serialize(
    Array.from({ length: 200 }, (_, i) => said(`[${i}] ${"y".repeat(1_000)}`)),
  );
  assert.ok(long.length > 1 && long.every((piece) => piece.length <= SUMMARY_INPUT));
  assert.ok(long[0]?.startsWith("[User]: [0] y"));
  assert.ok(long.at(-1)?.endsWith(`[199] ${"y".repeat(1_000)}`));
  assert.equal(long.join("\n\n").split("[User]: ").length - 1, 200);
});

test("a history past what one summary request reads is summarized a piece at a time, each updating the summary", async () => {
  const asks: string[] = [];
  const ask = async (_instructions: string, text: string) => {
    asks.push(text);
    return `summary ${asks.length}`;
  };
  const history = ["a", "b", "c"].map((name) => said(`[1] ${name.repeat(100_000)}`));
  const result = await summarize(ask, { history, prefix: [], upTo: 3 });
  assert.equal(asks.length, 3);
  assert.ok(asks[0]?.startsWith("<conversation>\n[User]: [1] a"));
  assert.ok(!asks[0]?.includes("<previous-summary>"));
  assert.ok(asks[2]?.includes("<previous-summary>\nsummary 2\n</previous-summary>"));
  assert.ok(asks[2]?.includes("The messages above are NEW conversation messages"));
  assert.equal(result.summary, "summary 3");
  // Each request stays within what one text of a model request can hold.
  assert.ok(asks.every((text) => text.length < 200_000));
  // With a summary before, the first piece updates it; a part longer than a piece is cut, and
  // says so; and past eight pieces the oldest are left out, and the first read says so.
  asks.length = 0;
  const previous = { summary: "before", upTo: 0 };
  const long = [said(`[1] ${"x".repeat(200_000)}`)];
  await summarize(ask, { history: long, prefix: [], upTo: 1, previous });
  assert.ok(asks[0]?.includes("<previous-summary>\nbefore\n</previous-summary>"));
  assert.match(asks[0] ?? "", /\[\.\.\. \d+ more characters truncated\]/);
  asks.length = 0;
  const many = Array.from({ length: 10 }, (_, i) => said(`[${i}] ${"z".repeat(100_000)}`));
  await summarize(ask, { history: many, prefix: [], upTo: 10 });
  assert.equal(asks.length, 8);
  assert.ok(
    asks[0]?.startsWith("<conversation>\n[... 2 earlier pieces of the conversation left out]"),
  );
});

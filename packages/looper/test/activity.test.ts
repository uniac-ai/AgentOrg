import assert from "node:assert/strict";
import test from "node:test";
import type { OutputItem, WorkEntry } from "../src/index.ts";
import {
  handsBack,
  held,
  idle,
  looperWith,
  newWork,
  says,
  sends,
  stops,
  until,
} from "./support.ts";

/** An entry as one line: a call's name and state, words, or a line. */
const shown = (entry: WorkEntry) =>
  "call" in entry
    ? `${entry.call.name} ${entry.call.state}`
    : "words" in entry
      ? `words: ${entry.words}`
      : `line: ${entry.line}`;
const hold = (callId: string): OutputItem[] => [
  { type: "function_call", callId, name: "hold", arguments: '{"at":"the sky"}' },
];

test("a piece of work's entries are its calls, what it wrote and didn't send, and its own lines; not what was said, nor the looper's own calls", async () => {
  const { tool, finish } = held();
  const { looper, asked, answer } = looperWith({ tools: [tool] });
  await looper.send("a", "Look at the sky.");
  await until(() => asked.length === 1, "the request");
  answer("Look at the sky.", [...says("Looking."), ...hold("c1"), ...hold("c2")]);
  await until(() => looper.state("a").state === "tool", "the call to run");
  await idle();
  // While it runs, the call is the last entry, running.
  assert.deepEqual((await looper.entries("a", undefined, 10)).entries.map(shown), [
    "words: Looking.",
    "hold running",
  ]);
  // Stopped, the call that ran ends, and the one that never ran is a line.
  const stopping = looper.stop();
  finish();
  await stopping;
  looper.start();
  await looper.send("a", "Go on.");
  await until(() => asked.length === 2, "the next request");
  answer("Go on.", [...handsBack(9), ...sends("Nobody", 9)]);
  await until(() => asked.length === 3, "the request after them");
  answer("Go on.", sends("Blue."));
  await looper.settled();
  const { entries, more } = await looper.entries("a", undefined, 10);
  assert.equal(more, false);
  assert.deepEqual(entries.map(shown), ["words: Looking.", "hold done", "line: hold: cancelled"]);
  const call = entries[1];
  assert.ok(call && "call" in call);
  assert.deepEqual(call.call, {
    name: "hold",
    state: "done",
    input: '{"at":"the sky"}',
    output: "held",
  });
});

test("a piece of work's entries page back from an entry, and from the call it is running", async () => {
  const { tool, finish } = held();
  const { looper, asked, answer } = looperWith({ tools: [tool] });
  await looper.send("a", "Think aloud.");
  await until(() => asked.length === 1, "the request");
  for (const [i, words] of ["One.", "Two.", "Three."].entries()) {
    answer(i === 0 ? "Think aloud." : "Go on.", says(words));
    await looper.settled();
    await looper.send("a", "Go on.");
    await until(() => asked.length === i + 2, "the next request");
  }
  const latest = await looper.entries("a", undefined, 2);
  assert.deepEqual(latest.entries.map(shown), ["words: Two.", "words: Three."]);
  assert.equal(latest.more, true);
  const older = await looper.entries("a", latest.entries[0]?.id, 2);
  assert.deepEqual(older.entries.map(shown), ["words: One."]);
  assert.equal(older.more, false);
  // From the call running now, paging back starts where what was kept ends.
  answer("Go on.", hold("c1"));
  await until(() => looper.state("a").state === "tool", "the call to run");
  const now = await looper.entries("a", undefined, 1);
  assert.deepEqual(now.entries.map(shown), ["hold running"]);
  assert.equal(now.more, true);
  const before = await looper.entries("a", now.entries[0]?.id, 1);
  assert.deepEqual(before.entries.map(shown), ["words: Three."]);
  await assert.rejects(looper.entries("nothing", undefined, 2), { code: "unknown" });
  finish();
  await looper.stop();
});

test("its pieces of work are listed most recently active first, each working, idle or stopped, with its latest entries", async () => {
  const { tool, finish } = held();
  const { looper, asked, said, answer } = looperWith({
    tools: [tool],
    routing: (text) =>
      text === "Stop." ? [...says("Stopped."), ...stops("b")] : newWork(`Work for ${text}`),
  });
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the first request");
  answer("First.", says("One."));
  await looper.settled();
  await looper.send("a", "Again.");
  await until(() => asked.length === 2, "the request again");
  answer("Again.", [...says("Two."), ...sends("Done.")]);
  await looper.settled();
  // Each is active a little after the one before.
  await new Promise((later) => setTimeout(later, 5));
  await looper.send("b", "Second.");
  await until(() => asked.length === 3, "the second request");
  await looper.send("b", "Stop.");
  await until(() => said.includes("b: assistant: Stopped."), "the stop");
  await looper.settled();
  await new Promise((later) => setTimeout(later, 5));
  await looper.send("c", "Third.");
  await until(() => asked.length === 4, "the third request");
  answer("Third.", hold("c1"));
  await until(() => looper.state("c").state === "tool", "the call to run");
  const works = await looper.works(6, 3);
  assert.deepEqual(
    works.map(({ id, state }) => `${id} ${state}`),
    ["c working", "b stopped", "a idle"],
  );
  assert.equal(works[0]?.title, "Work for Third.");
  assert.deepEqual(works[0]?.entries.map(shown), ["hold running"]);
  assert.deepEqual(works[2]?.entries.map(shown), ["words: One.", "words: Two."]);
  assert.equal(works[2]?.more, false);
  // At most `entries` of each, the latest, and whether more came before them.
  const [, , a] = await looper.works(6, 1);
  assert.deepEqual(a?.entries.map(shown), ["words: Two."]);
  assert.equal(a?.more, true);
  assert.deepEqual(
    (await looper.works(1, 3)).map(({ id }) => id),
    ["c"],
  );
  // From after a piece of work, in the same order.
  assert.deepEqual(
    (await looper.works(1, 3, "c")).map(({ id }) => id),
    ["b"],
  );
  assert.deepEqual(await looper.works(6, 3, "a"), []);
  await assert.rejects(looper.works(6, 3, "z"), /no such piece of work/);
  // A piece of work that has become active since still marks the same place.
  await looper.send("b", "Again.");
  await until(() => asked.length === 5, "b's next request");
  assert.equal((await looper.works(1, 3))[0]?.state, "working");
  assert.deepEqual(
    (await looper.works(6, 3, "b")).map(({ id }) => id),
    ["a"],
  );
  finish();
  await looper.stop();
});

test("the host is told a piece of work changed as its turn begins, as a call begins and ends, and once its end is kept", async () => {
  const { tool, finish } = held();
  finish();
  const { looper, asked, worked, answer } = looperWith({ tools: [tool] });
  await looper.send("a", "Look.");
  await until(() => asked.length === 1, "the request");
  // The turn has begun.
  assert.deepEqual(worked, ["a"]);
  answer("Look.", hold("c1"));
  await until(() => asked.length === 2, "the request after the call");
  // The call began, and it ended.
  assert.deepEqual(worked, ["a", "a", "a"]);
  answer("Look.", says("Seen."));
  await looper.settled();
  await idle();
  // What it wrote was kept, and its end.
  assert.deepEqual(worked, ["a", "a", "a", "a", "a"]);
});

test("a call in flight as its turn is stopped stays listed, as running, in a stopped work, until it is kept", async () => {
  const { tool, finish } = held();
  const { looper, asked, said, answer } = looperWith({
    tools: [tool],
    routing: (text) => (text === "Stop." ? [...says("Stopped."), ...stops("a")] : newWork()),
  });
  await looper.send("a", "Look.");
  await until(() => asked.length === 1, "the request");
  answer("Look.", hold("c1"));
  await until(() => looper.state("a").state === "tool", "the call to run");
  await looper.send("a", "Stop.");
  await until(() => said.includes("a: assistant: Stopped."), "the stop");
  await idle();
  const [work] = await looper.works(6, 3);
  assert.equal(work?.state, "stopped");
  assert.deepEqual(work?.entries.map(shown), ["hold running"]);
  finish();
  await looper.settled();
  const [after] = await looper.works(6, 3);
  assert.deepEqual(after?.entries.map(shown), ["hold done"]);
});

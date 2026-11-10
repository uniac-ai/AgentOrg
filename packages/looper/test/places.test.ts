import assert from "node:assert/strict";
import test from "node:test";
import { PLACES, WAITING } from "../src/index.ts";
import { gate, held, idle, looperWith } from "./support.ts";

test("turns run side by side up to the places; the next waits its turn, its message already said", async () => {
  const { looper, said, asked, answer, fill } = looperWith();
  await fill(["a", "b", "c", "d"]);
  assert.equal(asked.length, PLACES);

  await looper.send("e", "Work e.");
  await looper.send("f", "Work f.");
  await idle();
  assert.equal(asked.length, PLACES, "nothing more is asked of the model");
  assert.ok(said.includes("e: user: Work e."));
  assert.deepEqual(looper.state("e"), { state: "thinking" });
  // A thread that waits is in its turn: it takes no retry.
  await assert.rejects(looper.retry("e"), { name: "Refusal", code: "busy" });

  // A place freed goes to whoever has waited longest.
  answer("Work b.");
  await idle();
  assert.deepEqual(asked.slice(PLACES), ["Work e."]);
  answer("Work a.");
  await idle();
  assert.deepEqual(asked.slice(PLACES), ["Work e.", "Work f."]);
  for (const name of ["c", "d", "e", "f"]) answer(`Work ${name}.`);
  await looper.settled();
  assert.deepEqual(looper.state("f"), { state: "idle" });
  assert.ok(said.includes("f: assistant: Done."));
});

test("a thread already begun takes one more place, so new threads never keep a message from it", async () => {
  const { looper, asked, answer, fill } = looperWith();
  for (const begun of ["x", "y"]) {
    await looper.send(begun, `Start ${begun}.`);
    await idle();
    answer(`Start ${begun}.`);
    await looper.settled();
  }
  await fill(["a", "b", "c", "d"]);
  await looper.send("e", "Work e.");
  await looper.send("x", "More x.");
  await looper.send("y", "More y.");
  await idle();
  // The one more place is one: the second begun thread waits like any other.
  assert.deepEqual(asked.slice(-2), ["Work d.", "More x."]);

  // With five running, one ending frees no place for a new thread, only for the begun one.
  answer("Work a.");
  await idle();
  assert.equal(asked.at(-1), "More y.");
  answer("Work b.");
  await idle();
  assert.equal(asked.at(-1), "More y.");
  answer("Work c.");
  await idle();
  assert.equal(asked.at(-1), "Work e.");
  for (const text of ["Work d.", "More x.", "More y.", "Work e."]) answer(text);
  await looper.settled();
});

test("the line for a place holds so many turns; past that a message is refused, and nothing of it is kept", async () => {
  const { looper, said, asked, answer, fill } = looperWith();
  await fill(["old"]);
  answer("Work old.");
  await looper.settled();
  await fill(["a", "b", "c", "d"]);
  for (let i = 0; i < WAITING; i++) await looper.send(`waits ${i}`, "Work.");
  const full = {
    name: "Refusal",
    code: "busy",
    message: "Too many turns are waiting. Wait for one to start, or cancel one.",
  };
  await assert.rejects(looper.send("one more", "Hello."), full);
  assert.ok(!said.includes("one more: user: Hello."));
  assert.deepEqual((await looper.page("one more", undefined, 10)).messages, []);
  assert.deepEqual(looper.state("one more"), { state: "idle" });
  // The one more place is still there for a thread already begun.
  await looper.send("old", "More old.");
  await idle();
  assert.equal(asked.at(-1), "More old.");
  // A turn that leaves the line makes room in it.
  await looper.cancel("waits 0");
  await looper.send("one more", "Hello again.");
  assert.ok(said.includes("one more: user: Hello again."));
  await looper.stop();
});

test("a turn cancelled while it waits never starts, and one cancelled in a call keeps its place until the call ends", async () => {
  const { tool, called, finish } = held();
  const { looper, said, asked, answer, fill } = looperWith({ tools: [tool] });
  await fill(["a", "b", "c", "d"]);
  answer("Work a.", called);
  await looper.send("e", "Work e.");
  await looper.send("f", "Work f.");
  await idle();

  await looper.cancel("e");
  assert.deepEqual(looper.state("e"), { state: "idle" });
  // Its call is still running: the turn is over for its thread, and its place is not yet free.
  await looper.cancel("a");
  await idle();
  assert.equal(asked.length, PLACES);
  finish();
  await idle();
  assert.deepEqual(asked.slice(PLACES), ["Work f."]);
  assert.ok(said.includes("a: tool: hold: done"));
  for (const name of ["b", "c", "d", "f"]) answer(`Work ${name}.`);
  await looper.settled();
  assert.ok(!asked.includes("Work e."));
});

test("a turn cancelled before it asks for a place takes none, and a retry cancelled in the line leaves its reply", async () => {
  const { tool, called, finish } = held();
  const { looper, said, asked, answer, fill } = looperWith({ tools: [tool] });
  for (const begun of ["x", "y", "z"]) {
    await fill([begun]);
    answer(`Work ${begun}.`);
    await looper.settled();
  }
  await fill(["a", "b", "c", "d"]);
  answer("Work a.", called);
  await looper.send("x", "More x.");
  await looper.send("y", "More y.");
  await idle();
  assert.equal(asked.at(-1), "More x.", "five run, and one waits");

  // Cut in its call, the thread is free for a message, which first waits for the call to end.
  await looper.cancel("a");
  const sending = looper.send("a", "Again.");
  await looper.cancel("a");
  finish();
  await sending;
  await idle();
  assert.ok(said.includes("a: user: Again."));
  assert.equal(asked.at(-1), "More y.", "the place went to the one that waited");

  await looper.retry("z");
  await looper.cancel("z");
  assert.deepEqual(
    (await looper.page("z", undefined, 10)).messages.map((message) => message.text),
    ["Work z.", "Done."],
  );
  // Neither is left in the line: it takes all it holds.
  for (let i = 0; i < WAITING; i++) await looper.send(`waits ${i}`, "Work.");
  await looper.stop();
  assert.ok(!asked.includes("Again."));
});

test("a turn that will write nothing more gives its place back: one that failed, and one cancelled while the model answers", async () => {
  const { looper, asked, answer, fail, fill } = looperWith({ deaf: true });
  await fill(["a", "b", "c", "d"]);
  await looper.send("e", "Work e.");
  await looper.send("f", "Work f.");
  await idle();
  fail("Work a.");
  await idle();
  assert.deepEqual(looper.state("a").state, "error");
  assert.deepEqual(asked.slice(PLACES), ["Work e."]);
  // The model never hears this cancel, and its answer stays out: the place is free all the same.
  await looper.cancel("b");
  await idle();
  assert.deepEqual(asked.slice(PLACES), ["Work e.", "Work f."]);
  for (const name of ["b", "c", "d", "e", "f"]) answer(`Work ${name}.`);
  await looper.settled();
  assert.deepEqual(looper.state("b"), { state: "idle" });
});

test("stopped, every turn is cut, running or waiting, and no message is taken until it is started", async () => {
  const { looper, said, asked, answer, fill } = looperWith();
  await fill(["a", "b", "c", "d"]);
  await looper.send("e", "Work e.");
  await looper.stop();
  await idle();
  assert.equal(asked.length, PLACES, "the one that waited never started");
  for (const name of ["a", "e"]) assert.deepEqual(looper.state(name), { state: "idle" });
  const stopped = { name: "Refusal", code: "busy", message: "It is stopped. Start it to go on." };
  await assert.rejects(looper.send("a", "More."), stopped);
  await assert.rejects(looper.send("new", "Hello."), stopped);
  await assert.rejects(looper.retry("a"), stopped);
  assert.ok(!said.includes("a: user: More."));
  // One made stopped starts stopped.
  await assert.rejects(looperWith({ stopped: true }).looper.send("a", "Hello."), stopped);

  // Started, it takes messages again; what was cut stays cut.
  looper.start();
  await looper.send("a", "More.");
  await idle();
  assert.deepEqual(asked.slice(PLACES), ["More."]);
  answer("More.");
  await looper.settled();
  assert.ok(said.includes("a: assistant: Done."));
});

test("stopping answers when nothing more will be written: after a call still running, and a message being recorded", async () => {
  const { tool, called, finish } = held();
  const { shut: late, open: recorded } = gate();
  const { looper, said, asked, answer, fill } = looperWith({
    tools: [tool],
    writing: (key) => (key.startsWith("thread/late/") ? late : undefined),
  });
  await fill(["a"]);
  answer("Work a.", called);
  await idle();
  const sending = looper.send("late", "Just before.");
  await idle();
  let stopped = false;
  const stopping = looper.stop().then(() => {
    stopped = true;
  });
  await idle();
  assert.equal(stopped, false);
  recorded();
  await sending;
  await idle();
  assert.equal(stopped, false, "the call is still running");
  finish();
  await stopping;
  assert.ok(said.includes("late: user: Just before."));
  assert.ok(said.includes("a: tool: hold: done"));
  await idle();
  assert.deepEqual(asked, ["Work a."]);
});

test("closed, every turn is cut and no message is taken again", async () => {
  const { looper, asked, fill } = looperWith();
  await fill(["a"]);
  await looper.close();
  assert.deepEqual(looper.state("a"), { state: "idle" });
  const closed = { name: "Refusal", code: "unavailable" };
  await assert.rejects(looper.send("a", "Still there?"), closed);
  await assert.rejects(looper.send("new", "Hello."), closed);
  looper.start();
  await assert.rejects(looper.send("a", "Now?"), closed);
  assert.deepEqual(asked, ["Work a."]);
});

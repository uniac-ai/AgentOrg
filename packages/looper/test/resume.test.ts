import assert from "node:assert/strict";
import test from "node:test";
import type { Json } from "../src/index.ts";
import { gate, idle, looperWith, until } from "./support.ts";

const SHOWN = "Cut off by a restart: going on from where it stopped.";
const TOLD =
  "This turn was cut off by a restart. Check what is already done before you repeat anything, then go on.";
const marks = (values: Map<string, Json>) =>
  [...values.keys()].filter((key) => key.startsWith("unfinished/"));

test("a turn cut off by its looper closing goes on in the next, told once to check what is done", async () => {
  const first = looperWith();
  await first.fill(["a"]);
  assert.deepEqual(marks(first.values), ["unfinished/a"]);
  await first.looper.close();
  await first.looper.settled();
  assert.deepEqual(marks(first.values), ["unfinished/a"], "closed under, it stays marked");

  const second = looperWith({ values: first.values });
  await idle();
  assert.deepEqual(second.asked, [], "nothing goes on until it is asked to");
  await second.looper.resume();
  await until(() => second.asked.length === 1, "the turn to go on");
  assert.deepEqual(second.inputs, [["Work a.", TOLD]]);
  assert.deepEqual(second.said, [`a: tool: ${SHOWN}`]);
  assert.deepEqual(second.looper.state("a"), { state: "thinking" });
  // Asked again, it does nothing.
  await second.looper.resume();
  second.answer(TOLD);
  await second.looper.settled();
  assert.deepEqual(marks(second.values), []);
  assert.equal(second.asked.length, 1);

  const third = looperWith({ values: first.values });
  await third.looper.resume();
  await idle();
  assert.deepEqual(third.asked, []);
});

test("every turn left running goes on, each once", async () => {
  const first = looperWith();
  // Gone without closing, with three threads in their turns.
  await first.fill(["a", "b", "c"]);

  const second = looperWith({ values: first.values });
  await second.looper.resume();
  await until(() => second.asked.length === 3, "the three to go on");
  assert.deepEqual(
    second.inputs,
    ["a", "b", "c"].map((name) => [`Work ${name}.`, TOLD]),
  );
  await until(() => marks(second.values).length === 0, "the marks to go");
  await idle();
  assert.deepEqual(marks(second.values), [], "a turn that goes on is not marked");
  // Cut off again, it does not go on a second time.
  await second.looper.close();
  const third = looperWith({ values: first.values });
  await third.looper.resume();
  await idle();
  assert.deepEqual(third.asked, []);
  // The thread is as it was left, and takes a message.
  await third.looper.send("a", "Go on.");
  await until(() => third.asked.length === 1, "its turn");
  assert.deepEqual(third.inputs, [["Work a.", TOLD, "Go on."]]);
  await third.looper.stop();
});

test("a turn that ended, failed or was stopped leaves no mark, and one started after a failure and cut off goes on", async () => {
  const { looper, values, answer, fail, fill } = looperWith();
  await fill(["ended", "failed", "cancelled", "stopped"]);
  assert.equal(marks(values).length, 4);
  answer("Work ended.");
  fail("Work failed.");
  await looper.cancel("cancelled");
  await until(() => marks(values).length === 1, "three marks to go");
  assert.deepEqual(marks(values), ["unfinished/stopped"]);
  await looper.stop();
  await looper.settled();
  assert.deepEqual(marks(values), []);

  looper.start();
  await looper.send("failed", "Go on.");
  await until(() => marks(values).length === 1, "the new turn's mark");
  await looper.close();
  await looper.settled();
  assert.deepEqual(marks(values), ["unfinished/failed"]);
  const again = looperWith({ values });
  await again.looper.resume();
  await until(() => again.asked.length === 1, "that turn to go on");
  assert.deepEqual(again.inputs, [["Work failed.", "Go on.", TOLD]]);
  await again.looper.stop();
});

test("a stopped looper goes on with nothing, and its marks go", async () => {
  const first = looperWith();
  await first.fill(["a"]);
  const second = looperWith({ values: first.values, stopped: true });
  await second.looper.resume();
  await second.looper.settled();
  assert.deepEqual(marks(second.values), []);
  second.looper.start();
  await idle();
  assert.deepEqual(second.asked, []);
});

test("a stop or a close that lands as a turn would go on stays one", async () => {
  for (const end of ["stop", "close"] as const) {
    const first = looperWith();
    await first.fill(["a"]);
    const read = gate();
    const second = looperWith({
      values: first.values,
      reading: (key) => (key.startsWith("thread/a/") ? read.shut : undefined),
    });
    const resuming = second.looper.resume();
    await idle();
    const ending = second.looper[end]();
    read.open();
    await Promise.all([resuming, ending]);
    await second.looper.settled();
    await idle();
    assert.deepEqual(second.asked, [], end);
    assert.deepEqual(second.said, [], end);
    assert.deepEqual(second.looper.state("a"), { state: "idle" }, end);
    // Stopped, the turn is not gone on with later; closed under, it is, by the next looper.
    assert.deepEqual(marks(second.values), end === "stop" ? [] : ["unfinished/a"], end);
  }
});

test("a thread with a turn of its own keeps its mark for that turn, and is not gone on with", async () => {
  const first = looperWith();
  await first.fill(["a"]);
  const read = gate();
  const second = looperWith({
    values: first.values,
    reading: (key) => (key.startsWith("thread/a/") ? read.shut : undefined),
  });
  // Said before the turns cut off are looked for, and still on its way in when they are.
  const sending = second.looper.send("a", "Still there?");
  const resuming = second.looper.resume();
  await idle();
  read.open();
  await Promise.all([sending, resuming]);
  await until(() => second.asked.length === 1, "its own turn");
  assert.deepEqual(second.inputs, [["Work a.", "Still there?"]]);
  await idle();
  assert.deepEqual(marks(second.values), ["unfinished/a"]);
  second.answer("Still there?");
  await second.looper.settled();
  assert.deepEqual(marks(second.values), []);
});

test("a turn that can't go on now keeps its mark, and a thread with nothing kept has none to go on with", async () => {
  const first = looperWith();
  await first.fill(["a"]);
  first.values.set("unfinished/empty", true);

  let failing = true;
  const refusing = (key: string) =>
    failing && key.startsWith("unfinished/") ? Promise.reject(new Error("no")) : undefined;
  const second = looperWith({ values: first.values, reading: refusing });
  // The marks can't be listed: asked again, it looks again.
  await assert.rejects(second.looper.resume());
  failing = false;
  const unread = looperWith({
    values: first.values,
    reading: (key) => (key.startsWith("thread/a/") ? Promise.reject(new Error("no")) : undefined),
  });
  await unread.looper.resume();
  await unread.looper.settled();
  assert.deepEqual(unread.asked, []);
  assert.deepEqual(marks(unread.values), ["unfinished/a"], "the empty thread's mark is gone");

  await second.looper.resume();
  await until(() => second.asked.length === 1, "the turn to go on");
  await second.looper.stop();
});

test("a thread that has had a turn since is not gone on with, however late its mark is read", async () => {
  const first = looperWith();
  await first.fill(["a", "b"]);
  const read = gate();
  const second = looperWith({
    values: first.values,
    reading: (key) => (key.startsWith("thread/a/") ? read.shut : undefined),
  });
  // Held up on the first thread, while the second has a turn of its own that ends.
  const resuming = second.looper.resume();
  await idle();
  await second.looper.send("b", "And now?");
  await until(() => second.asked.length === 1, "its own turn");
  second.answer("And now?");
  await until(() => second.looper.state("b").state === "idle", "that turn to end");
  read.open();
  await resuming;
  await until(() => second.asked.length === 2, "the first thread to go on");
  assert.deepEqual(second.inputs[1], ["Work a.", TOLD]);
  await idle();
  assert.equal(second.asked.length, 2, "the second thread is not asked again");
  assert.deepEqual(marks(second.values), []);
  await second.looper.stop();
});

test("closing as the marks are read starts nothing and leaves them, and a message recorded as it closes is marked", async () => {
  const first = looperWith();
  await first.fill(["a", "b"]);
  const listed = gate();
  const second = looperWith({
    values: first.values,
    reading: (key) => (key === "unfinished/" ? listed.shut : undefined),
  });
  const resuming = second.looper.resume();
  await idle();
  await second.looper.close();
  listed.open();
  await resuming;
  await idle();
  assert.deepEqual(second.asked, []);
  assert.deepEqual(marks(second.values), ["unfinished/a", "unfinished/b"]);

  const written = gate();
  const third = looperWith({
    writing: (key) => (key.startsWith("thread/c/") ? written.shut : undefined),
  });
  const sending = third.looper.send("c", "Just before.");
  await idle();
  await third.looper.close();
  written.open();
  await sending;
  await third.looper.settled();
  assert.deepEqual(marks(third.values), ["unfinished/c"]);
  const fourth = looperWith({ values: third.values });
  await fourth.looper.resume();
  await until(() => fourth.asked.length === 1, "its turn");
  assert.deepEqual(fourth.inputs, [["Just before.", TOLD]]);
  await fourth.looper.stop();
});

test("a stop that lands as the line is written leaves nothing to go on with", async () => {
  const first = looperWith();
  await first.fill(["a"]);
  const written = gate();
  const second = looperWith({
    values: first.values,
    writing: (key) => (key.startsWith("thread/a/") ? written.shut : undefined),
  });
  const resuming = second.looper.resume();
  await idle();
  const stopping = second.looper.stop();
  written.open();
  await Promise.all([resuming, stopping]);
  await second.looper.settled();
  assert.deepEqual(second.asked, []);
  assert.deepEqual(marks(second.values), []);
});

test("stopped before the turns cut off were looked for, a looper goes on with none once started", async () => {
  const first = looperWith();
  await first.fill(["a"]);
  const second = looperWith({ values: first.values });
  await second.looper.stop();
  assert.deepEqual(marks(second.values), []);
  second.looper.start();
  await second.looper.resume();
  await idle();
  assert.deepEqual(second.asked, []);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Json } from "../src/index.ts";
import { gate, held, idle, looperWith, newWork, says, until } from "./support.ts";

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

test("work with a turn of its own keeps its mark for that turn, and is not gone on with", async () => {
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

test("a turn that can't go on now keeps its mark, and work with nothing kept has none to go on with", async () => {
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

test("work that has had a turn since is not gone on with, however late its mark is read", async () => {
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

test("closing as the marks are read starts nothing and leaves them, and a message recorded as it closes waits to be placed", async () => {
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
  // Nobody had said whose it is: it waits for the main loop, which the next looper asks.
  assert.ok(third.values.has("unrouted/c"));
  assert.deepEqual(third.routed, []);
  const fourth = looperWith({ values: third.values });
  await fourth.looper.resume();
  await until(() => fourth.asked.length === 1, "its turn");
  assert.equal(fourth.routed.length, 1);
  assert.deepEqual(fourth.inputs, [["Just before."]]);
  assert.equal(fourth.values.has("unrouted/c"), false);
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

test("a turn cut off while a call ran goes on, though the request that made the call wrote something too", async () => {
  const { tool, called } = held();
  const first = looperWith({ tools: [tool] });
  await first.looper.send("a", "Do the thing.");
  await until(() => first.asked.length === 1, "the work's request");
  first.answer("Do the thing.", [...says("Let me check."), ...called]);
  await until(() => first.said.includes("a: tool: hold: running"), "the call to start");
  await idle();

  // It went with the call still running: what it wrote is kept, and the call has no result.
  const second = looperWith({ tools: [tool], values: new Map(first.values) });
  await second.looper.resume();
  await until(() => second.asked.length === 1, "the turn to go on");
  assert.deepEqual(second.said, [`a: tool: ${SHOWN}`]);
  await second.looper.stop();
  await first.looper.close();
});

test("a turn that kept nothing before its looper went leaves nothing to go on with, also in work that was stopped", async () => {
  const { tool, called, finish } = held();
  let armed = false;
  let left: Map<string, Json> | undefined;
  const never = gate();
  const first = looperWith({
    tools: [tool],
    // The looper goes as the next message is written: the turn's mark is kept, the message not.
    writing: (key) => {
      if (!armed || !key.startsWith("thread/a/msg/")) return undefined;
      armed = false;
      left = new Map(first.values);
      return never.shut;
    },
  });
  await first.looper.send("a", "Do the thing.");
  await until(() => first.asked.length === 1, "the work's request");
  first.answer("Do the thing.", called);
  await until(() => first.said.includes("a: tool: hold: running"), "the call to start");
  await first.looper.cancel("a");
  finish();
  await first.looper.settled();
  await idle();
  assert.deepEqual(marks(first.values), [], "stopped, it has no mark");
  armed = true;
  first.looper.send("a", "Next.").catch(() => {});
  await until(() => left !== undefined, "the message to be written");
  assert.deepEqual(marks(left as Map<string, Json>), ["unfinished/a"]);

  const second = looperWith({ tools: [tool], values: left as Map<string, Json> });
  await second.looper.resume();
  await idle();
  assert.deepEqual(second.asked, [], "the stopped turn does not go on");
  assert.deepEqual(marks(second.values), []);
  await second.looper.stop();
  await first.looper.close();
});

for (const how of ["stop", "cancel"] as const)
  test(`a ${how} that lands while a turn's mark is being written leaves no mark, and nothing to go on with`, async () => {
    // New work, whose turn opens on the message the main loop decided on: marked twice.
    const hold = gate();
    let writes = 0;
    const first = looperWith({
      writing: (key) => (key === "unfinished/a" && ++writes === 1 ? hold.shut : undefined),
    });
    await first.looper.send("a", "Do it.");
    await until(() => writes === 1, "the mark to be written");
    const stopping = how === "stop" ? first.looper.stop() : first.looper.cancel("a");
    await idle();
    hold.open();
    await stopping;
    await first.looper.settled();
    await idle();
    assert.deepEqual(marks(first.values), []);

    // The same while a thread is first read, before the mark is written.
    const reading = gate();
    let read = false;
    const second = looperWith({
      values: await rested(),
      reading: (key) => {
        if (key !== "thread/a/msg/" || read) return undefined;
        read = true;
        return reading.shut;
      },
    });
    await second.looper.resume();
    const sending = second.looper.send("a", "And a summary.");
    await until(() => read, "the thread to be read");
    const cutting = how === "stop" ? second.looper.stop() : second.looper.cancel("a");
    await idle();
    reading.open();
    await cutting;
    await sending;
    await second.looper.settled();
    await idle();
    assert.deepEqual(marks(second.values), []);
    const third = looperWith({ values: new Map(second.values) });
    await third.looper.resume();
    await idle();
    assert.deepEqual(third.asked, []);
    await first.looper.close();
  });

/** A store whose one piece of work, in thread `a`, is at rest after a turn. */
async function rested() {
  const made = looperWith();
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the work's request");
  made.answer("Write the report.", says("Report done."));
  await made.looper.settled();
  await idle();
  await made.looper.close();
  return new Map(made.values);
}

test("only a message said to the work past its mark says its turn kept something: not what the main loop said, nor what a stopped turn still wrote", async () => {
  // What the main loop said beside placing the work stands between two places.
  let left: Map<string, Json> | undefined;
  const first = looperWith({
    routing: () => [...says("On it."), ...newWork("The report")],
    writing: (key) => {
      if (key === "thread/a/msg/000000000003") left ??= new Map(first.values);
      return undefined;
    },
  });
  await first.looper.send("a", "Write the report.");
  await until(() => first.asked.length === 1, "the work's request");
  first.answer("Write the report.", []);
  await first.looper.settled();
  await idle();
  await first.looper.send("a", "Are you there?");
  assert.equal(left?.has("thread/a/msg/000000000003"), false, "left before the message was kept");
  const second = looperWith({ values: left as Map<string, Json> });
  await second.looper.resume();
  await idle();
  assert.deepEqual(second.asked, []);

  // A stopped turn's call ends between the next turn's mark and its message.
  const { tool, called, finish } = held();
  const hold = gate();
  let writes = 0;
  let after: Map<string, Json> | undefined;
  const third = looperWith({
    tools: [tool],
    writing: (key) => {
      // Its first turn is marked twice, and the next once.
      if (key === "unfinished/b" && ++writes === 3) return hold.shut;
      if (key === "thread/b/msg/000000000003") after ??= new Map(third.values);
      return undefined;
    },
  });
  await third.looper.send("b", "Run it.");
  await until(() => third.asked.length === 1, "the work's request");
  third.answer("Run it.", called);
  await until(() => third.said.includes("b: tool: hold: running"), "the call to start");
  await third.looper.cancel("b");
  const sending = third.looper.send("b", "Something else.");
  await until(() => writes === 3, "the next turn's mark to be written");
  finish();
  await idle();
  hold.open();
  await sending;
  assert.equal(after?.has("thread/b/msg/000000000002"), true, "the call's result is kept");
  assert.equal(after?.has("thread/b/msg/000000000003"), false, "and the message is not");
  const fourth = looperWith({ values: after as Map<string, Json>, tools: [tool] });
  await fourth.looper.resume();
  await idle();
  assert.deepEqual(fourth.asked, [], "the stopped turn does not go on");
  await first.looper.close();
  await third.looper.close();
});

test("a looper that closes as new work's first turn is starting leaves that turn to go on", async () => {
  const hold = gate();
  let marking = false;
  const first = looperWith({
    writing: (key) => {
      if (key !== "unfinished/a" || marking) return undefined;
      marking = true;
      return hold.shut;
    },
  });
  await first.looper.send("a", "Write the report.");
  await until(() => marking, "the work's mark to be written");
  await first.looper.close();
  hold.open();
  await idle();
  assert.deepEqual(first.asked, []);

  // The work holds the message the main loop decided on, and no other: its mark says a turn.
  const second = looperWith({ values: new Map(first.values) });
  await second.looper.resume();
  await until(() => second.asked.length === 1, "the turn to go on");
  assert.deepEqual(second.inputs, [["Write the report.", TOLD]]);
  await second.looper.stop();
});

for (const how of ["stopped and then closed", "closed"] as const)
  test(`work ${how} while a message to it is being written ${how === "closed" ? "goes on" : "does not go on"} in the next looper`, async () => {
    const hold = gate();
    let armed = false;
    const first = looperWith({
      writing: (key) => {
        if (!armed || !key.startsWith("thread/a/msg/")) return undefined;
        armed = false;
        return hold.shut;
      },
    });
    await first.looper.send("a", "Write the report.");
    await until(() => first.asked.length === 1, "the work's request");
    first.answer("Write the report.", says("Report done."));
    await first.looper.settled();
    await idle();
    armed = true;
    const sending = first.looper.send("a", "And a summary.");
    await until(() => !armed, "the message to be written");
    if (how !== "closed") await first.looper.cancel("a");
    await idle();
    await first.looper.close();
    hold.open();
    await sending;
    await idle();

    const second = looperWith({ values: new Map(first.values) });
    await second.looper.resume();
    await idle();
    assert.equal(second.asked.length, how === "closed" ? 1 : 0);
    await second.looper.stop();
  });

for (const how of ["close", "stop"] as const)
  test(`a ${how} that lands while the marks are being read starts no turn after it`, async () => {
    const first = looperWith();
    await first.fill(["a"]);
    await first.looper.close();
    const hold = gate();
    let reading = false;
    const second = looperWith({
      values: new Map(first.values),
      reading: (key) => {
        if (key !== "unfinished/a" || reading) return undefined;
        reading = true;
        return hold.shut;
      },
    });
    const resuming = second.looper.resume();
    await until(() => reading, "the work's mark to be read");
    const cutting = how === "close" ? second.looper.close() : second.looper.stop();
    await idle();
    hold.open();
    await Promise.all([resuming, cutting]);
    await idle();
    assert.deepEqual(second.asked, []);
    // Closed, it leaves the turn to the next; stopped, nothing goes on any more.
    assert.deepEqual(marks(second.values), how === "close" ? ["unfinished/a"] : []);
    const third = looperWith({ values: new Map(second.values) });
    await third.looper.resume();
    await idle();
    assert.equal(third.asked.length, how === "close" ? 1 : 0);
    await third.looper.stop();
  });

for (const how of ["is not kept before the looper goes", "is refused by the store"] as const)
  test(`a turn the close cut stays to be gone on with when a message asked before the close ${how}`, async () => {
    const hold = gate();
    let armed = false;
    let left: Map<string, Json> | undefined;
    const first = looperWith({
      writing: (key) => {
        if (!armed || !key.startsWith("thread/a/msg/")) return undefined;
        armed = false;
        left = new Map(first.values);
        return hold.shut;
      },
    });
    await first.fill(["a"]);
    first.answer("Work a.", says("Done."));
    await first.looper.settled();
    await first.looper.send("a", "And a summary.");
    await until(() => first.asked.length === 2, "the turn's request");
    // A second message and the close, one after the other: the message is taken after the close.
    armed = true;
    const sending = first.looper.send("a", "And a chart.").catch(() => {});
    const closing = first.looper.close();
    await until(() => left !== undefined, "the second message to be written");
    await closing;
    if (how === "is refused by the store") hold.fail();
    else hold.open();
    await sending;
    await idle();

    const stored = how === "is refused by the store" ? first.values : (left as Map<string, Json>);
    const second = looperWith({ values: new Map(stored) });
    await second.looper.resume();
    await until(() => second.asked.length === 1, "the cut turn to go on");
    assert.deepEqual(second.inputs, [["Work a.", "Done.", "And a summary.", TOLD]]);
    await second.looper.stop();
  });

test("a message sent before the turns cut off were looked for leaves the cut turn to go on, if the looper goes before it is kept", async () => {
  const first = looperWith();
  await first.fill(["a"]);
  first.answer("Work a.", says("Done."));
  await first.looper.settled();
  await first.looper.send("a", "And a summary.");
  await until(() => first.asked.length === 2, "the turn's request");
  // It goes without closing; the next is sent a message before it is asked to go on, and goes
  // as that message is written.
  const hold = gate();
  let left: Map<string, Json> | undefined;
  const second = looperWith({
    values: new Map(first.values),
    writing: (key) => {
      if (left || !key.startsWith("thread/a/msg/")) return undefined;
      left = new Map(second.values);
      return hold.shut;
    },
  });
  const sending = second.looper.send("a", "And a chart.").catch(() => {});
  await until(() => left !== undefined, "the message to be written");

  const third = looperWith({ values: new Map(left as Map<string, Json>) });
  await third.looper.resume();
  await until(() => third.asked.length === 1, "the cut turn to go on");
  assert.deepEqual(third.inputs, [["Work a.", "Done.", "And a summary.", TOLD]]);
  hold.open();
  await sending;
  await Promise.all([first.looper.close(), second.looper.close(), third.looper.stop()]);
});

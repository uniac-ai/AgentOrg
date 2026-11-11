import assert from "node:assert/strict";
import test from "node:test";
import { gate, held, idle, looperWith, says, until } from "./support.ts";

const texts = async (looper: ReturnType<typeof looperWith>["looper"], thread: string) =>
  (await looper.page(thread, undefined, 50)).messages.map((message) => message.text);

test("a message said while the model answers is recorded at once, and the turn answers it before it ends", async () => {
  const { looper, said, asked, inputs, answer } = looperWith();
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the first request");
  await looper.send("a", "Second.");
  assert.deepEqual(said, ["a: user: First.", "a: user: Second."]);
  await idle();
  assert.deepEqual(asked, ["First."], "the answer on its way is not asked again");

  answer("First.", says("First done."));
  await until(() => asked.length === 2, "the second request");
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  // The model reads its reply before the message that reply never saw.
  assert.deepEqual(inputs[1], ["First.", "First done.", "Second."]);
  // A third, said while the second is answered, comes after the answer to the second.
  await looper.send("a", "Third.");
  answer("Second.", says("Second done."));
  await until(() => asked.length === 3, "the third request");
  assert.deepEqual(inputs[2], ["First.", "First done.", "Second.", "Second done.", "Third."]);
  answer("Third.", says("All done."));
  await looper.settled();
  assert.deepEqual(looper.state("a"), { state: "idle" });
  // The thread shows them as they were said.
  assert.deepEqual(await texts(looper, "a"), [
    "First.",
    "Second.",
    "First done.",
    "Third.",
    "Second done.",
    "All done.",
  ]);
});

test("a message said while a tool runs is in the next request, after the call", async () => {
  const { tool, called, finish } = held();
  const { looper, asked, inputs, answer } = looperWith({ tools: [tool] });
  await looper.send("a", "Hold it.");
  await until(() => asked.length === 1, "the request");
  answer("Hold it.", called);
  await idle();
  await looper.send("a", "And name it Fern.");
  finish();
  await until(() => asked.length === 2, "the next request");
  assert.deepEqual(inputs[1], ["Hold it.", "call hold", "output held", "And name it Fern."]);
  answer("And name it Fern.");
  await looper.settled();
  assert.equal(asked.length, 2, "one more request, not two");
});

test("a message being recorded as its turn would end is answered by that turn", async () => {
  const late = gate();
  const { looper, asked, answer } = looperWith({
    writing: (key) =>
      key.startsWith("thread/") && key.endsWith("000000000002") ? late.shut : undefined,
  });
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the request");
  const sending = looper.send("a", "Second.");
  await idle();
  answer("First.", says("First done."));
  await idle();
  // The turn has nothing more to do, and doesn't end over a message on its way into the record.
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  assert.deepEqual(asked, ["First."]);
  late.open();
  await sending;
  await until(() => asked.length === 2, "the request that reads it");
  answer("Second.");
  await looper.settled();
  assert.deepEqual(looper.state("a"), { state: "idle" });
});

test("a message said as its turn ends starts the next turn", async () => {
  let again: Promise<unknown> | undefined;
  const { looper, values, asked, inputs, answer } = looperWith({
    // Asked just after the turn has asked for its end: taken once the turn is over.
    saying(line) {
      if (line === "a: assistant: First done.")
        queueMicrotask(() => {
          again = looper.send("a", "Second.");
        });
    },
  });
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the request");
  answer("First.", says("First done."));
  await until(() => asked.length === 2, "the next turn's request");
  await again;
  assert.deepEqual(inputs[1], ["First.", "First done.", "Second."]);
  // It opened a turn of its own, with no stopped turn still writing: it is not kept as joined.
  assert.equal("joined" in (values.get("thread/a/msg/000000000003") as object), false);
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  answer("Second.");
  await looper.settled();
  assert.deepEqual(looper.state("a"), { state: "idle" });
});

test("messages said while a cut turn's call still runs are recorded at once, and their turn reads them after that call's result", async () => {
  const { tool, called, finish } = held();
  const { looper, said, asked, inputs, answer } = looperWith({ tools: [tool] });
  await looper.send("a", "Hold it.");
  await until(() => asked.length === 1, "the request");
  answer("Hold it.", called);
  await until(() => said.includes("a: tool: hold: running"), "the call to start");
  await looper.cancel("a");
  // Both are kept and said while the call runs; the turn they start is shown, and asks nothing yet.
  const sending = [looper.send("a", "First."), looper.send("a", "Second.")];
  await until(() => said.at(-1) === "a: user: Second.", "both to be said");
  await Promise.all(sending);
  assert.deepEqual(await texts(looper, "a"), ["Hold it.", "First.", "Second."]);
  assert.deepEqual(said.slice(-2), ["a: user: First.", "a: user: Second."]);
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  await idle();
  assert.equal(asked.length, 1);
  finish();
  await until(() => asked.length === 2, "the request");
  assert.deepEqual(inputs[1], ["Hold it.", "call hold", "output held", "First.", "Second."]);
  await looper.stop();
});

test("a message said while a cut turn's reply is still being stored is recorded at once, and read after that reply", async () => {
  const late = gate();
  const { looper, said, asked, inputs, answer } = looperWith({
    writing: (key) => (key === "thread/a/msg/000000000002" ? late.shut : undefined),
  });
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the request");
  answer("First.", says("First done."));
  await idle();
  await looper.cancel("a");
  await looper.send("a", "Second.");
  assert.equal(said.at(-1), "a: user: Second.");
  await idle();
  assert.equal(asked.length, 1);
  late.open();
  await until(() => asked.length === 2, "the request");
  assert.deepEqual(inputs[1], ["First.", "First done.", "Second."]);
  await looper.stop();
});

test("a cancel stays a cancel: what was asked before it starts and continues nothing", async () => {
  const late = gate();
  const { looper, said, asked } = looperWith({
    writing: (key) =>
      key.startsWith("thread/") && key.endsWith("000000000002") ? late.shut : undefined,
  });
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the request");
  const sending = looper.send("a", "Second.");
  await idle();
  await looper.cancel("a");
  late.open();
  // Not refused: it is in the record.
  assert.ok((await sending).messageId);
  await idle();
  assert.ok(said.includes("a: user: Second."));
  assert.deepEqual(asked, ["First."]);
  assert.deepEqual(looper.state("a"), { state: "idle" });

  // The same with the turn at its end, behind two messages still to be taken: nothing waits on
  // anything else, and both are kept.
  const slow = gate();
  const other = looperWith({
    writing: (key) =>
      key.startsWith("thread/") && key.endsWith("000000000002") ? slow.shut : undefined,
  });
  await other.looper.send("b", "First.");
  await until(() => other.asked.length === 1, "the request");
  const sent = [other.looper.send("b", "Second."), other.looper.send("b", "Third.")];
  await idle();
  other.answer("First.", says("First done."));
  await idle();
  await other.looper.cancel("b");
  slow.open();
  await Promise.all(sent);
  await other.looper.settled();
  assert.deepEqual(other.asked, ["First."]);
  assert.deepEqual(await texts(other.looper, "b"), ["First.", "Second.", "First done.", "Third."]);
});

test("a turn cancelled as it ends holds nothing up: the next message starts its turn", async () => {
  // Cancelled while its reply is written, or while a message is recorded as it would end.
  for (const joins of [false, true]) {
    const late = gate();
    const { looper, asked, answer } = looperWith({
      writing: (key) =>
        key.startsWith("thread/") && key.endsWith("000000000002") ? late.shut : undefined,
    });
    await looper.send("a", "First.");
    await until(() => asked.length === 1, "the request");
    const joining = joins ? looper.send("a", "Second.") : undefined;
    await idle();
    answer("First.", says("First done."));
    await idle();
    await looper.cancel("a");
    const next = looper.send("a", "Next.");
    late.open();
    await Promise.all([joining, next]);
    await until(() => asked.at(-1) === "Next.", "the next turn");
    answer("Next.");
    await looper.settled();
    assert.deepEqual(looper.state("a"), { state: "idle" });
  }
});

test("the looper's stop waits for what a turn cut as its reply is written still writes", async () => {
  const { tool, called } = held();
  const late = gate();
  const { looper, asked, answer } = looperWith({
    tools: [tool],
    writing: (key) =>
      key.startsWith("thread/") && key.endsWith("000000000002") ? late.shut : undefined,
  });
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the request");
  // Its reply, with a call, is on its way into the record as the turn is cut.
  answer("First.", [{ type: "message", role: "assistant", content: "Holding." }, ...called]);
  await idle();
  const stopping = looper.stop();
  let stopped = false;
  void stopping.then(() => {
    stopped = true;
  });
  await idle();
  assert.equal(stopped, false, "stopping waits for what the turn still writes");
  late.open();
  await stopping;
  assert.deepEqual(await texts(looper, "a"), ["First.", "Holding.", "hold: cancelled"]);
});

test("a first message the store refuses, with a second behind it, leaves the thread's loop in use", async () => {
  const first = gate();
  const { looper, asked } = looperWith({
    writing: (key) =>
      key.startsWith("thread/") && key.endsWith("000000000001") ? first.shut : undefined,
  });
  const one = looper.send("a", "One.");
  const two = looper.send("a", "Two.");
  first.fail();
  await assert.rejects(one);
  await two;
  await until(() => asked.length === 1, "the second message's turn");
  // The turn is the thread's: it is seen, and stopped, by its name.
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  await looper.cancel("a");
  assert.deepEqual(looper.state("a"), { state: "idle" });
});

test("a message the store refuses while its turn runs is never read by the model", async () => {
  const { tool, called, finish } = held();
  const late = gate();
  const { looper, asked, inputs, answer } = looperWith({
    tools: [tool],
    writing: (key) =>
      key.startsWith("thread/") && key.endsWith("000000000002") ? late.shut : undefined,
  });
  await looper.send("a", "Hold it.");
  await until(() => asked.length === 1, "the request");
  answer("Hold it.", called);
  await idle();
  const refused = looper.send("a", "Never kept.");
  await idle();
  finish();
  await until(() => asked.length === 2, "the next request");
  assert.deepEqual(inputs[1], ["Hold it.", "call hold", "output held"]);
  late.fail();
  await assert.rejects(refused);
  answer("Hold it.");
  await looper.settled();
  assert.equal(asked.length, 2);
});

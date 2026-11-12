import assert from "node:assert/strict";
import test from "node:test";
import { held, kept, looperWith, newWork, routeTo, says, sends, stops, until } from "./support.ts";

/** The number the message `text` had in the request whose lines are `lines`. */
const numberOf = (lines: string[] | undefined, text: string) =>
  Number(/^\[(\d+)\] /.exec(lines?.find((line) => line.endsWith(`] ${text}`)) ?? "")?.[1]);
const texts = async (looper: ReturnType<typeof looperWith>["looper"], thread: string) =>
  (await looper.page(thread, undefined, 50)).messages.map((message) => message.text);

test("what a worker writes without sending is kept for its work and said in no thread; its next request reads it", async () => {
  const { looper, values, said, asked, inputs, answer } = looperWith();
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the request");
  answer("Write the report.", [...says("Drafting the outline."), ...sends("On it.")]);
  await looper.settled();
  assert.deepEqual(said, ["a: user: Write the report.", "a: assistant: On it."]);
  assert.deepEqual(await texts(looper, "a"), ["Write the report.", "On it."]);
  assert.deepEqual(kept(values, "a"), ["Write the report.", "Drafting the outline.", "On it."]);
  await looper.send("a", "Go on.");
  await until(() => asked.length === 2, "the next request");
  assert.deepEqual(inputs[1], ["Write the report.", "Drafting the outline.", "On it.", "Go on."]);
});

test("a send is said in the thread of the message it answers, and a worker may send to several, more than once", async () => {
  const { looper, said, asked, numbered, answer } = looperWith({
    routing: (text) => (text === "Add a chart." ? routeTo("a") : newWork("The report")),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the report's request");
  answer("Write the report.", sends("On it."));
  await looper.settled();
  await looper.send("b", "Add a chart.");
  await until(() => asked.length === 2, "the request that reads it");
  const chart = numberOf(numbered[1], "Add a chart.");
  answer("Add a chart.", [
    ...sends("Adding it.", chart),
    ...sends("The report is longer now.", 1),
    ...sends("Added.", chart),
  ]);
  await looper.settled();
  assert.deepEqual(said.slice(-4), [
    "b: user: Add a chart.",
    "b: assistant: Adding it.",
    "a: assistant: The report is longer now.",
    "b: assistant: Added.",
  ]);
});

test("a send that names no message of its work, or says nothing, is refused, and the worker is told so", async () => {
  const { looper, said, asked, inputs, failures, answer } = looperWith();
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the request");
  answer("Write the report.", [
    ...sends("To nobody.", 9),
    { type: "function_call", callId: "s2", name: "send", arguments: '{"message":1,"text":" "}' },
  ]);
  await until(() => asked.length === 2, "the request that reads what they came to");
  const outputs = (inputs[1] ?? []).filter((line) => line.startsWith("output"));
  assert.match(outputs[0] ?? "", /There is no message \[9\] of this work to answer/);
  assert.match(outputs[1] ?? "", /Give the message's number and what to say\./);
  answer("Write the report.", sends("Done."));
  await looper.settled();
  assert.deepEqual(said, ["a: user: Write the report.", "a: assistant: Done."]);
  assert.deepEqual(failures, []);
});

test("a turn that ends by itself leaves what it neither answered nor handed back not answered, said once", async () => {
  const { looper, values, said, asked, failures, answer } = looperWith();
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the request");
  answer("First.", says("Thinking about it."));
  await looper.settled();
  assert.deepEqual(failures, ["a: not_answered"]);
  assert.deepEqual(said, ["a: user: First."]);
  // Kept on the message: nothing else is kept for it.
  assert.deepEqual(kept(values, "a"), ["First.", "Thinking about it."]);
  assert.equal((values.get("thread/a/msg/000000000001") as { unanswered?: true }).unanswered, true);
  // The next turn reads it with the rest, and it is not said again.
  await looper.send("a", "Second.");
  await until(() => asked.length === 2, "the next request");
  answer("Second.", sends("Here."));
  await looper.settled();
  assert.deepEqual(failures, ["a: not_answered"]);
});

test("a stopped turn leaves nothing not answered, nor does the next turn leave what the stopped one had", async () => {
  const { looper, said, asked, numbered, failures, answer } = looperWith({
    routing: (text) => (text === "Stop." ? [...says("Stopped."), ...stops("a")] : newWork()),
  });
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the request");
  await looper.send("a", "Stop.");
  await until(() => said.length === 3, "the thread to be told");
  await looper.settled();
  assert.deepEqual(failures, []);
  // The next turn answers its own message only.
  await looper.send("a", "Second.");
  await until(() => asked.length === 2, "the next request");
  answer("Second.", sends("Here.", numberOf(numbered[1], "Second.")));
  await looper.settled();
  assert.deepEqual(failures, []);
});

test("what a worker sends is read back whole, however long, as what it said", async () => {
  const long = "x".repeat(40_000);
  const { looper, asked, inputs, answer } = looperWith();
  await looper.send("a", "Write it out.");
  await until(() => asked.length === 1, "the request");
  answer("Write it out.", sends(long));
  await looper.settled();
  await looper.send("a", "Thanks.");
  await until(() => asked.length === 2, "the next request");
  assert.deepEqual(inputs[1], ["Write it out.", long, "Thanks."]);
});

test("after a send the model is asked again, reads that it was sent, and a request that calls nothing ends the turn", async () => {
  const { looper, said, asked, raw, working, answer } = looperWith({ askAfterSend: true });
  await looper.send("a", "Hello.");
  await until(() => asked.length === 1, "the request");
  answer("Hello.", sends("Hi."));
  await until(() => asked.length === 2, "the request after the send");
  assert.deepEqual(said, ["a: user: Hello.", "a: assistant: Hi."]);
  assert.deepEqual(working, [true]);
  // The model reads the send as its call, and its output.
  assert.deepEqual(
    raw[1]?.slice(1).map((item) => {
      const { callId: _, ...rest } = item as { callId: string };
      return rest;
    }),
    [
      { type: "function_call", name: "send", arguments: '{"message":1,"text":"Hi."}' },
      { type: "function_call_output", output: "Sent." },
    ],
  );
  answer("Hello.", []);
  await looper.settled();
  assert.deepEqual(working, [true, false]);
  assert.equal(asked.length, 2);
});

test("a turn that goes on after a restart leaves what it took and didn't answer not answered, in each chat", async () => {
  const first = looperWith({
    routing: (text) => (text === "Add a chart." ? routeTo("a") : newWork("The report")),
  });
  await first.looper.send("a", "Write the report.");
  await until(() => first.asked.length === 1, "the request");
  await first.looper.send("b", "Add a chart.");
  await until(() => first.mains.length === 2, "the main loop to give it to that work");
  await first.looper.close();
  const second = looperWith({ values: first.values });
  await second.looper.resume();
  await until(() => second.asked.length === 1, "the turn to go on");
  // Named by what it last read: the words that say it was cut off.
  second.answer(
    second.asked[0] as string,
    sends("Chart added.", numberOf(second.numbered[0], "Add a chart.")),
  );
  await second.looper.settled();
  assert.deepEqual(second.said, ["b: assistant: Chart added."]);
  assert.deepEqual(second.failures, ["a: not_answered"]);
});

test("a page asked for before a message that is not said starts where that message stands", async () => {
  const { tool, called, finish } = held();
  finish();
  const { looper, values, asked, answer } = looperWith({ tools: [tool] });
  await looper.send("a", "Run it.");
  await until(() => asked.length === 1, "the request");
  answer("Run it.", called);
  await until(() => asked.length === 2, "the request after the call");
  answer("Run it.", sends("Done."));
  await looper.settled();
  // As a view that paged before calls were hidden holds it.
  const call = values.get("thread/a/msg/000000000002") as { id: string; role: string };
  assert.equal(call.role, "tool");
  const page = await looper.page("a", call.id, 10);
  assert.deepEqual(
    page.messages.map((message) => message.text),
    ["Run it."],
  );
  assert.equal(page.more, false);
});

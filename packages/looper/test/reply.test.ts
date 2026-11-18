import assert from "node:assert/strict";
import test from "node:test";
import type { Json, Tool } from "../src/index.ts";
import {
  gate,
  held,
  kept,
  looperWith,
  newWork,
  routeTo,
  says,
  sends,
  stops,
  until,
} from "./support.ts";

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

test("a response that only sends, answering all it took, ends the turn without asking again; a call beside a send goes on, and reads that it was sent", async () => {
  const { tool, calls, finish } = held();
  finish();
  const waiting = gate();
  const wait: Tool = {
    name: "wait",
    parameters: {},
    run: async () => {
      await waiting.shut;
      return { output: "waited", ok: true };
    },
  };
  const { looper, said, asked, raw, numbered, working, answer } = looperWith({
    askAfterSend: true,
    tools: [tool, wait],
  });
  await looper.send("a", "Hello.");
  await until(() => asked.length === 1, "the request");
  answer("Hello.", sends("Hi."));
  await looper.settled();
  assert.deepEqual(said, ["a: user: Hello.", "a: assistant: Hi."]);
  assert.deepEqual(working, [true, false]);
  assert.equal(asked.length, 1);
  // A line on where it stands, with its next call beside it: asked again, it reads both.
  await looper.send("a", "Look it up.");
  await until(() => asked.length === 2, "the next turn's request");
  answer("Look it up.", [...sends("Looking."), ...calls(1)]);
  await until(() => asked.length === 3, "the request after the call");
  assert.deepEqual(
    raw[2]?.slice(-4).map((item) => {
      const { callId: _, ...rest } = item as { callId: string };
      return rest;
    }),
    [
      { type: "function_call", name: "send", arguments: '{"message":3,"text":"Looking."}' },
      { type: "function_call_output", output: "Sent." },
      { type: "function_call", name: "hold", arguments: "{}" },
      { type: "function_call_output", output: "held" },
    ],
  );
  answer("Look it up.", sends("Found it."));
  await looper.settled();
  assert.equal(asked.length, 3);
  // A message said while it answered is answered before the turn ends.
  await looper.send("a", "First.");
  await until(() => asked.length === 4, "the request");
  await looper.send("a", "Second.");
  answer("First.", sends("One."));
  await until(() => asked.length === 5, "the request for the message said meanwhile");
  answer("Second.", sends("Two."));
  await looper.settled();
  assert.equal(asked.length, 5);
  // Two messages read in one request, and only one answered: asked again for the other.
  await looper.send("a", "Run it.");
  await until(() => asked.length === 6, "the request");
  answer("Run it.", [{ type: "function_call", callId: "w1", name: "wait", arguments: "{}" }]);
  await until(() => looper.state("a").state === "tool", "the call to run");
  await looper.send("a", "And this.");
  waiting.open();
  await until(() => asked.length === 7, "the request that reads both");
  answer("And this.", sends("Ran it.", numberOf(numbered[6], "Run it.")));
  await until(() => asked.length === 8, "the request for the one left");
  answer("And this.", sends("This too."));
  await looper.settled();
  assert.equal(asked.length, 8);
  assert.deepEqual(working, [true, false, true, false, true, false, true, false]);
});

test("a response that sends with its steps ends the turn as one that only sends; one that only keeps its steps goes on", async () => {
  const { tool, calls, finish } = held();
  finish();
  const { looper, asked, answer } = looperWith({ askAfterSend: true, tools: [tool] });
  const steps = (callId: string, args: Json) => ({
    type: "function_call" as const,
    callId,
    name: "status",
    arguments: JSON.stringify(args),
  });
  await looper.send("a", "Look it up.");
  await until(() => asked.length === 1, "the request");
  answer("Look it up.", [
    steps("s1", { steps: [{ text: "Look it up", state: "in_progress" }] }),
    ...sends("Found it."),
  ]);
  await looper.settled();
  assert.equal(asked.length, 1);
  // Its message answered and a call beside it, then its steps alone: it goes on, asked again.
  await looper.send("a", "And the rest.");
  await until(() => asked.length === 2, "the request");
  answer("And the rest.", [...sends("On it."), ...calls(1)]);
  await until(() => asked.length === 3, "the request after the call");
  answer("And the rest.", [steps("s2", { advance: true })]);
  await until(() => asked.length === 4, "the request after its steps alone");
  answer("And the rest.", []);
  await looper.settled();
  assert.equal(asked.length, 4);
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

test("a reply an earlier version kept is read by the model as sent, to the message before it", async () => {
  const first = looperWith();
  await first.looper.send("a", "First.");
  await until(() => first.asked.length === 1, "the request");
  first.answer("First.", says("Done before."));
  await first.looper.settled();
  // As an earlier version kept it: words said to the person, with nothing of it marked.
  const reply = "thread/a/msg/000000000002";
  const { unsent: _, ...earlier } = first.values.get(reply) as { unsent: true };
  first.values.set(reply, earlier as Json);
  const message = "thread/a/msg/000000000001";
  const { unanswered: __, ...said } = first.values.get(message) as { unanswered: true };
  first.values.set(message, said as Json);
  const second = looperWith({ values: first.values });
  await second.looper.send("a", "Second.");
  await until(() => second.asked.length === 1, "the request");
  const read = (second.raw[0] ?? []).map((item) => {
    const { callId: ___, ...rest } = item as { callId?: string };
    return rest;
  });
  assert.deepEqual(read, [
    { type: "message", role: "user", content: "[1] First." },
    {
      type: "function_call",
      name: "send",
      arguments: '{"message":1,"text":"Done before."}',
    },
    { type: "function_call_output", output: "Sent." },
    { type: "message", role: "user", content: "[3] Second." },
  ]);
  second.answer("Second.", sends("Done."));
  await second.looper.settled();
});

test("a reply an earlier version kept answers its message for a turn that goes on after the upgrade", async () => {
  const { tool, called, finish } = held();
  finish();
  const first = looperWith({ tools: [tool] });
  await first.looper.send("a", "First.");
  await until(() => first.asked.length === 1, "the first request");
  first.answer("First.", sends("Done."));
  await first.looper.settled();
  // A turn the next message starts: it is marked as starting after what the work held.
  await first.looper.send("a", "Second.");
  await until(() => first.asked.length === 2, "the second request");
  first.answer("Second.", [...says("Done before."), ...called]);
  await until(() => first.asked.length === 3, "the request after the call");
  // The app goes with the turn still at work.
  await first.looper.close();
  // As an earlier version kept the reply: words said to the person, with nothing of it marked.
  const reply = [...first.values].find(
    ([key, value]) => key.startsWith("thread/a/") && (value as { unsent?: true }).unsent,
  );
  assert.ok(reply);
  const { unsent: _, ...earlier } = reply[1] as { unsent: true };
  first.values.set(reply[0], earlier as Json);
  const second = looperWith({ tools: [tool], values: first.values });
  await second.looper.resume();
  await until(() => second.asked.length === 1, "the turn to go on");
  second.answer(second.asked[0] as string, []);
  await second.looper.settled();
  assert.deepEqual(second.failures, []);
});

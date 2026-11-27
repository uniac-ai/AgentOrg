import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_AFTER,
  CONVERSATION_INSTRUCTIONS,
  CONVERSATION_OFFERED,
} from "../src/conversation.ts";
import type { OutputItem, Tool } from "../src/index.ts";
import { PLACES } from "../src/looper.ts";
import { VOICE } from "../src/main.ts";
import { closes, gate, handsBack, looperWith, passes, says, sends, until } from "./support.ts";

/** A conversation's loop stopping the work of that id. */
const stops = (work: string): OutputItem[] => [
  {
    type: "function_call",
    callId: `route-${crypto.randomUUID()}`,
    name: "route",
    arguments: JSON.stringify({ stop: work }),
  },
];
/** A host's function a conversation's loop may call, which keeps what it is given in `kept`. */
const keeping = () => {
  const kept: unknown[] = [];
  const tool: Tool = {
    name: "notes__keep",
    description: "Keep a note.",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    run: async (input) => {
      kept.push(input);
      return { output: "Kept.", ok: true };
    },
  };
  return { tool, kept };
};
/** The ids of the work kept in a looper's store. */
const worksIn = (values: Map<string, unknown>) =>
  [...values.keys()].filter((key) => key.startsWith("work/")).map((key) => key.slice(5));

test("a message goes to its conversation's own loop, told the front desk's words in a loop's terms and offered send, no_reply_needed and route; what it sends is the reply", async () => {
  const { looper, said, asked, talks, mains } = looperWith({
    conversations: "routes",
    voice: "You are Scout.",
    talking: () => sends("Hello. What can I do?"),
  });
  await looper.send("a", "Hi.");
  await until(() => said.length === 2, "the answer");
  await looper.settled();
  assert.deepEqual(said, ["a: user: Hi.", "a: assistant: Hello. What can I do?"]);
  // No main loop and no worker was asked.
  assert.deepEqual(mains, []);
  assert.deepEqual(asked, []);
  assert.equal(talks.length, 1);
  assert.deepEqual(talks[0]?.tools, ["send", "no_reply_needed", "route"]);
  assert.equal(
    talks[0]?.instructions,
    `${CONVERSATION_INSTRUCTIONS}\n\n${VOICE}\n\nYou are Scout.\n\n${CONVERSATION_AFTER}`,
  );
  // The work there is comes last, apart from what it is told, which stays the same.
  assert.deepEqual(talks[0]?.input, ["[1] Hi.", "There is no work."]);
});

test("a message passed on to new work starts it under its title, and its worker answers; the conversation's loop asks nothing more", async () => {
  const { looper, values, said, asked, talks, answer } = looperWith({
    conversations: "routes",
    talking: () => passes("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's turn");
  const [work] = worksIn(values).filter((id) => id !== "a");
  assert.ok(work);
  assert.deepEqual(values.get(`work/${work}`), { title: "The report", follows: ["a"] });
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  assert.deepEqual(said, ["a: user: Write the report.", "a: assistant: Report done."]);
  assert.equal(talks.length, 1);
});

test("a receipt given with new work is said first and answers nothing: the work takes the message, shows it taken, and answers it", async () => {
  const { looper, said, asked, talks, progress, answer } = looperWith({
    conversations: "routes",
    talking: () => passes("The report", undefined, undefined, "On it."),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's turn");
  assert.deepEqual(said, ["a: user: Write the report.", "a: assistant: On it."]);
  // Still open: taken by the work, not answered by the receipt.
  assert.match(String(progress.at(-1)), / taken$/);
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  assert.deepEqual(said, [
    "a: user: Write the report.",
    "a: assistant: On it.",
    "a: assistant: Report done.",
  ]);
  assert.match(String(progress.at(-1)), / answered$/);
  assert.equal(talks.length, 1);
});

test("a message said while work runs in the conversation goes to its own loop, told that work is in a turn; passed on to it, that turn takes it", async () => {
  let work = "";
  const { looper, values, asked, inputs, talks, answer } = looperWith({
    conversations: "routes",
    talking: (text) => (text === "Write the report." ? passes("The report") : passes("", work)),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's turn");
  work = worksIn(values).find((id) => id !== "a") ?? "";
  assert.ok(work);
  await looper.send("a", "And add a summary.");
  await until(() => talks.length === 2, "the conversation's loop to hear it");
  // Not the work's: its own loop has it first, and is told the work is in a turn.
  assert.match(String(talks[1]?.input.at(-1)), new RegExp(`- ${work}: The report \\(in a turn\\)`));
  answer("Write the report.", sends("Report done."));
  await until(() => asked.length === 2, "the work's next request");
  assert.deepEqual(inputs[1], ["Write the report.", "Report done.", "And add a summary."]);
  answer("And add a summary.", sends("Summary added."));
  await looper.settled();
});

test("a stop is the conversation's: route with stop cuts that work's turn, and its loop reads what came of it before it answers", async () => {
  let work = "";
  const { looper, values, said, asked, talks } = looperWith({
    conversations: "routes",
    talking: (text, { input }) =>
      text === "Write the report."
        ? passes("The report")
        : input.at(-2)?.type === "function_call_output"
          ? sends("Stopped it.")
          : stops(work),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's turn");
  work = worksIn(values).find((id) => id !== "a") ?? "";
  await looper.send("a", "Stop that.");
  await until(() => said.includes("a: assistant: Stopped it."), "the answer");
  await looper.settled();
  assert.equal(looper.state(work).state, "idle");
  // Its answer came after what the stop gave back.
  assert.equal(talks.length, 3);
  assert.ok(talks[2]?.input.includes("output Stopped."));
});

test("a message the work hands back comes back to the conversation's loop, after a line saying which work did and why", async () => {
  const { looper, values, said, asked, talks, answer } = looperWith({
    conversations: "routes",
    talking: (text) =>
      talks.length <= 1 && text === "Write the report."
        ? passes("The report")
        : sends("I'll do it here."),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's turn");
  const [work] = worksIn(values).filter((id) => id !== "a");
  answer("Write the report.", handsBack(1, "It isn't a report."));
  await until(() => talks.length === 2, "it to come back");
  // It comes back as the newest in its own order, after the line, before the work there is.
  assert.deepEqual(talks[1]?.input.slice(-3, -1), [
    `The next message was passed on, and handed back: "The report" (${work}): It isn't a report.`,
    "[4] Write the report.",
  ]);
  await until(() => said.includes("a: assistant: I'll do it here."), "the answer");
  await looper.settled();
});

test("a message that asks for nothing is closed by the conversation's loop with no reply, with its reaction", async () => {
  const { looper, said, progress, reactions } = looperWith({
    conversations: "routes",
    talking: () => closes("👍"),
  });
  await looper.send("a", "Thanks!");
  await until(() => reactions.length === 1, "the close");
  await looper.settled();
  assert.deepEqual(said, ["a: user: Thanks!"]);
  assert.match(String(progress.at(-1)), / closed$/);
  assert.match(String(reactions[0]), / 👍$/);
});

test("a conversation's loop takes none of the places turns of work share: with all held, it still answers", async () => {
  const { looper, said, asked, fill } = looperWith({
    conversations: "routes",
    talking: (text) => (text === "Hi." ? sends("Hello.") : passes(text)),
  });
  await fill(["w", "x", "y", "z", "v"].slice(0, PLACES));
  await looper.send("b", "Hi.");
  await until(() => said.includes("b: assistant: Hello."), "the answer");
  assert.equal(asked.length, PLACES);
  await looper.stop();
});

test("a host's function the conversation's loop calls runs, and what it gives is read back before it answers", async () => {
  const { tool, kept } = keeping();
  const { looper, said, talks } = looperWith({
    conversations: "routes",
    frontDesk: [tool],
    talking: () =>
      talks.length === 1
        ? [
            {
              type: "function_call",
              callId: "keep-1",
              name: "notes__keep",
              arguments: JSON.stringify({ text: "Their name is Sam." }),
            },
          ]
        : sends("Noted, Sam."),
  });
  await looper.send("a", "Call me Sam.");
  await until(() => said.length === 2, "the answer");
  await looper.settled();
  assert.deepEqual(kept, [{ text: "Their name is Sam." }]);
  assert.deepEqual(talks[0]?.tools, ["notes__keep", "send", "no_reply_needed", "route"]);
  assert.match(
    String(talks[0]?.instructions),
    new RegExp(CONVERSATION_OFFERED.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")),
  );
  assert.deepEqual(talks[1]?.input.slice(-3, -1), [
    'call notes__keep {"text":"Their name is Sam."}',
    "output Kept.",
  ]);
  assert.deepEqual(said, ["a: user: Call me Sam.", "a: assistant: Noted, Sam."]);
});

test("a route naming no message of its own, or work there isn't, is refused, and the loop is told why", async () => {
  const { looper, said, talks } = looperWith({
    conversations: "routes",
    talking: () =>
      talks.length === 1
        ? [...passes("", "nobody"), ...passes("The report", undefined, 9)]
        : sends("Done."),
  });
  await looper.send("a", "Write the report.");
  await until(() => said.length === 2, "the answer");
  await looper.settled();
  const outputs = talks[1]?.input.filter((one) => one.startsWith("output ")) ?? [];
  assert.match(String(outputs[0]), /"code":"invalid".*There is no work .*nobody/);
  assert.match(String(outputs[1]), /"code":"invalid".*None of your messages has that number/);
});

test("a conversation's own loop is listed among the work there is as this conversation, from its first turn, with its calls", async () => {
  const answering = gate();
  const { looper, asked, talks, answer } = looperWith({
    conversations: "routes",
    talking: () => answering.shut.then(() => passes("Work")),
  });
  await looper.send("a", "Write the report.");
  await until(() => talks.length === 1, "its first request");
  assert.deepEqual(
    (await looper.works(10, 5)).map(({ id, title, state }) => ({ id, title, state })),
    [{ id: "a", title: "This conversation", state: "working" }],
  );
  answering.open();
  await until(() => asked.length === 1, "the work's turn");
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  const listed = await looper.works(10, 5);
  const own = listed.find((one) => one.id === "a");
  assert.equal(own?.title, "This conversation");
  assert.ok(own?.entries.some((one) => "call" in one && one.call?.name === "route"));
  assert.ok(listed.some((one) => one.id !== "a" && one.title === "Work"));
});

test("what a looper without conversations kept is read by the conversation's loop: its thread's own work's record and the main loop's answers; nothing is lost", async () => {
  // Before: the main loop answered once, then started work of the thread's own name, which answered.
  const before = looperWith({
    routing: (text) => (text === "Hi." ? says("Hello.") : undefined),
  });
  await before.looper.send("a", "Hi.");
  await until(() => before.said.length === 2, "the main loop's answer");
  await before.looper.send("a", "Write the report.");
  await until(() => before.asked.length === 1, "the work's turn");
  before.answer("Write the report.", sends("Report done."));
  await before.looper.settled();
  await before.looper.close();
  // After: the same store, with conversations.
  const after = looperWith({
    values: before.values,
    conversations: "routes",
    talking: () => sends("It said the report is done."),
  });
  await after.looper.send("a", "What did it say?");
  await until(() => after.said.length === 1, "the answer");
  await after.looper.settled();
  // Every message said there is its, numbered in its order, with what its work did.
  assert.deepEqual(after.talks[0]?.input, [
    "[1] Hi.",
    "Hello.",
    "[3] Write the report.",
    'call send {"message":3,"text":"Report done."}',
    "output Sent.",
    "[5] What did it say?",
    "There is no work.",
  ]);
  assert.deepEqual(
    (await after.looper.page("a", undefined, 10)).messages.map((one) => one.text),
    [
      "Hi.",
      "Hello.",
      "Write the report.",
      "Report done.",
      "What did it say?",
      "It said the report is done.",
    ],
  );
});

test("a message a looper without conversations left waiting for its main loop is taken by the conversation's loop when the next looper goes on", async () => {
  // Before: the main loop is asked and never answers, and the looper closes under it.
  const answering = gate();
  const before = looperWith({ routing: () => answering.shut.then(() => says("Late.")) });
  await before.looper.send("a", "Hi.");
  await until(() => before.mains.length === 1, "the main loop's request");
  await before.looper.close();
  // After: the same store, with conversations, goes on with what waited.
  const after = looperWith({
    values: before.values,
    conversations: "routes",
    talking: () => sends("Hello."),
  });
  await after.looper.resume();
  await until(() => after.said.length === 1, "the answer");
  await after.looper.settled();
  assert.deepEqual(after.said, ["a: assistant: Hello."]);
  assert.deepEqual(after.talks[0]?.input, ["[1] Hi.", "There is no work."]);
  answering.open();
});

test("a function a conversation's loop isn't offered is refused: it hands nothing back and keeps no steps", async () => {
  const { looper, said, talks } = looperWith({
    conversations: "routes",
    talking: () =>
      talks.length === 1
        ? [
            ...handsBack(1, "Not mine."),
            {
              type: "function_call",
              callId: "status-1",
              name: "status",
              arguments: JSON.stringify({ steps: [{ step: "Look", state: "doing" }] }),
            },
          ]
        : sends("Here."),
  });
  await looper.send("a", "Hi.");
  await until(() => said.length === 2, "the answer");
  await looper.settled();
  const outputs = talks[1]?.input.filter((one) => one.startsWith("output ")) ?? [];
  assert.equal(outputs.length, 2);
  for (const output of outputs) assert.match(output, /"code":"unknown_tool"/);
});

test("passing a message to work that handed it back is refused, and nothing changes for it", async () => {
  let work = "";
  const { looper, values, said, asked, talks, answer } = looperWith({
    conversations: "routes",
    talking: () =>
      talks.length === 1
        ? passes("The report")
        : talks.length === 2
          ? passes("", work)
          : sends("I'll answer it."),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's turn");
  work = worksIn(values).find((id) => id !== "a") ?? "";
  answer("Write the report.", handsBack(1, "It isn't a report."));
  await until(() => said.includes("a: assistant: I'll answer it."), "the answer");
  await looper.settled();
  assert.match(
    String(talks[2]?.input.at(-2)),
    /"code":"invalid".*handed this message back already/,
  );
  assert.equal(asked.length, 1);
});

test("two messages passed on in one response are each taken by their work", async () => {
  const answering = gate();
  const { looper, asked, talks, answer } = looperWith({
    conversations: "routes",
    talking: () =>
      talks.length === 1
        ? answering.shut.then(() => [
            ...passes("First", undefined, 1),
            ...passes("Second", undefined, 2),
          ])
        : [],
  });
  await looper.send("a", "One.");
  await until(() => talks.length === 1, "the conversation's request");
  // Said while it answers: it joins its turn, and is passed on in the same response.
  await looper.send("a", "Two.");
  answering.open();
  await until(() => asked.length === 2, "both works' turns");
  answer("One.", sends("One done."));
  answer("Two.", sends("Two done."));
  await looper.settled();
  assert.deepEqual([...asked].sort(), ["One.", "Two."]);
});

test("a conversation's loop is told which work is another conversation's", async () => {
  const { looper, asked, talks, answer } = looperWith({
    conversations: "routes",
    talking: (text) => (text === "Write the report." ? passes("The report") : sends("Hello.")),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's turn");
  await looper.send("b", "Hi.");
  await until(() => talks.length === 2, "the other conversation's loop");
  assert.match(
    String(talks[1]?.input.at(-1)),
    /: The report \(in a turn; in another conversation\)$/,
  );
  answer("Write the report.", sends("Report done."));
  await looper.settled();
});

test("a conversation's turn cut off by its looper closing goes on, once, when the next looper does", async () => {
  // Before: its request never answers, and the looper closes under it.
  const answering = gate();
  const before = looperWith({
    conversations: "routes",
    talking: () => answering.shut.then(() => sends("Late.")),
  });
  await before.looper.send("a", "Hi.");
  await until(() => before.talks.length === 1, "its request");
  await before.looper.close();
  // Marked, with the place its turn starts after.
  assert.ok(before.values.has("unfinished/a"));
  // After: the same store goes on with it, and it answers.
  const after = looperWith({
    values: before.values,
    conversations: "routes",
    talking: () => sends("Hello."),
  });
  await after.looper.resume();
  await until(() => after.said.length === 1, "the answer");
  await after.looper.settled();
  assert.deepEqual(after.said, ["a: assistant: Hello."]);
  assert.equal(after.values.has("unfinished/a"), false);
  answering.open();
});

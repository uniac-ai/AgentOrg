import assert from "node:assert/strict";
import test from "node:test";
import type { OutputItem, Tool } from "../src/index.ts";
import { ALONE, FRAME_ALONE } from "../src/loop.ts";
import { PLACES } from "../src/looper.ts";
import { HEARD_ALONE, ROUTE } from "../src/main.ts";
import {
  gate,
  handsBack,
  held,
  idle,
  looperWith,
  newWork,
  passes,
  says,
  sends,
  stops,
  until,
} from "./support.ts";

/** A host's function the agent may call, which keeps what it is given in `kept`. */
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
/** A call of the agent's, with these arguments. */
const call = (name: string, args: object): OutputItem[] => [
  {
    type: "function_call",
    callId: `${name}-${crypto.randomUUID()}`,
    name,
    arguments: JSON.stringify(args),
  },
];

test("alone, a conversation's own loop is told a worker's frame with no front desk, its host's words and its lines on answering, and offered every tool with send, status and no_reply_needed", async () => {
  const { tool } = keeping();
  const { looper, said, asked, told, mains, answer } = looperWith({
    conversations: "alone",
    instructions: "You help with notes.",
    tools: [tool],
  });
  await looper.send("a", "Hi.");
  await until(() => asked.length === 1, "its request");
  assert.equal(told[0]?.instructions, `${FRAME_ALONE}\n\nYou help with notes.\n\n${ALONE}`);
  assert.doesNotMatch(String(told[0]?.instructions), /front desk|piece of work|hand_back/);
  assert.deepEqual(told[0]?.tools, ["notes__keep", "send", "status", "no_reply_needed"]);
  answer("Hi.", sends("Hello."));
  await looper.settled();
  assert.deepEqual(said, ["a: user: Hi.", "a: assistant: Hello."]);
  // No front desk decided on it.
  assert.deepEqual(mains, []);
});

test("alone, it does the work itself: what a call gives is read back before it answers", async () => {
  const { tool, kept } = keeping();
  const { looper, said, asked, inputs, answer } = looperWith({
    conversations: "alone",
    tools: [tool],
  });
  await looper.send("a", "Call me Sam.");
  await until(() => asked.length === 1, "its request");
  answer("Call me Sam.", call("notes__keep", { text: "Sam" }));
  await until(() => asked.length === 2, "its next request");
  assert.deepEqual(kept, [{ text: "Sam" }]);
  assert.deepEqual(inputs[1], ["Call me Sam.", "call notes__keep", "output Kept."]);
  answer("Call me Sam.", sends("Noted, Sam."));
  await looper.settled();
  assert.deepEqual(said, ["a: user: Call me Sam.", "a: assistant: Noted, Sam."]);
});

test("alone, a conversation's loop takes a place as work does: past the places, a conversation waits its turn, its message already said", async () => {
  const { looper, said, asked, answer } = looperWith({ conversations: "alone" });
  const names = Array.from({ length: PLACES + 1 }, (_, i) => `t${i}`);
  for (const name of names) await looper.send(name, `Work ${name}.`);
  await until(() => asked.length === PLACES, "a request for each place");
  await idle();
  assert.equal(asked.length, PLACES);
  const last = names.at(-1);
  assert.ok(said.includes(`${last}: user: Work ${last}.`));
  // A place freed goes to the conversation that waited.
  answer("Work t0.", sends("Done."));
  await until(() => asked.length === PLACES + 1, "the next conversation's request");
  assert.equal(asked.at(-1), `Work ${last}.`);
  await looper.stop();
});

test("alone, a message said while one of its calls is in flight is heard apart; one that asks to stop ends that call and says nothing, and the agent reads it next and answers it", async () => {
  const hold = held();
  const groups: string[] = [];
  const { looper, said, asked, inputs, mains, answer } = looperWith({
    conversations: "alone",
    tools: [hold.tool],
    // The call in flight ends when its group is asked to.
    stopGroup: async (group) => {
      groups.push(group);
      hold.finish();
    },
    routing: (text) => (text === "Stop that." ? [...says("Stopped it."), ...stops("a")] : []),
  });
  await looper.send("a", "Scan everything.");
  await until(() => asked.length === 1, "its request");
  answer("Scan everything.", hold.called);
  await until(() => hold.groups.length === 1, "the long call");
  await looper.send("a", "Stop that.");
  // The call is asked to end, by its turn's group, and the turn goes on.
  await until(() => asked.length === 2, "its next request");
  assert.deepEqual(groups, hold.groups);
  // Heard with its own words, the turn whose call it may end, and `route` alone.
  assert.equal(mains[0]?.instructions, HEARD_ALONE);
  assert.deepEqual(mains[0]?.tools, [ROUTE]);
  assert.deepEqual(mains[0]?.input, [
    "The work there is:\n- a: This conversation (in a turn)",
    "Stop that.",
  ]);
  // It reads what the call gave and the message, and answers it itself: what the hearing wrote
  // is said nowhere.
  assert.deepEqual(inputs[1]?.slice(-3), ["call hold", "output held", "Stop that."]);
  answer("Stop that.", sends("Stopped the scan."));
  await looper.settled();
  assert.deepEqual(said, [
    "a: user: Scan everything.",
    "a: user: Stop that.",
    "a: assistant: Stopped the scan.",
  ]);
  assert.equal(looper.state("a").state, "idle");
});

test("alone, a stop heard while one of its calls is in flight ends that call, and what the same response called after it doesn't start", async () => {
  const hold = held();
  const { tool, kept } = keeping();
  const { looper, said, asked, inputs, answer } = looperWith({
    conversations: "alone",
    tools: [hold.tool, tool],
    stopGroup: async () => hold.finish(),
    routing: (text) => (text === "Stop that." ? stops("a") : []),
  });
  await looper.send("a", "Scan, then keep a note.");
  await until(() => asked.length === 1, "its request");
  answer("Scan, then keep a note.", [...hold.called, ...call("notes__keep", { text: "Scanned." })]);
  await until(() => hold.groups.length === 1, "the long call");
  await looper.send("a", "Stop that.");
  await until(() => asked.length === 2, "its next request");
  // The note is never kept: the model reads the call that ran, and the stop.
  assert.deepEqual(kept, []);
  assert.deepEqual(inputs[1]?.slice(-3), ["call hold", "output held", "Stop that."]);
  answer("Stop that.", sends("Stopped the scan; no note kept."));
  await looper.settled();
  assert.equal(said.at(-1), "a: assistant: Stopped the scan; no note kept.");
});

test("alone, a message said while one of its calls is in flight that asks for no stop ends nothing: the call runs to its end, and it reads the message next", async () => {
  const hold = held();
  const groups: string[] = [];
  const { looper, said, asked, inputs, mains, answer } = looperWith({
    conversations: "alone",
    tools: [hold.tool],
    stopGroup: async (group) => void groups.push(group),
    routing: () => [],
  });
  await looper.send("a", "Make a.txt.");
  await until(() => asked.length === 1, "its request");
  answer("Make a.txt.", hold.called);
  await until(() => hold.groups.length === 1, "its call");
  await looper.send("a", "And b.txt.");
  await until(() => mains.length === 1, "it to be heard");
  await idle();
  assert.deepEqual(groups, []);
  hold.finish();
  await until(() => asked.length === 2, "its next request");
  assert.deepEqual(inputs[1]?.slice(-3), ["call hold", "output held", "And b.txt."]);
  answer("And b.txt.", sends("Made both."));
  await looper.settled();
  assert.deepEqual(said, [
    "a: user: Make a.txt.",
    "a: user: And b.txt.",
    "a: assistant: Made both.",
  ]);
});

test("alone, a stop said while it writes, with no call in flight, isn't heard apart: it is read at its next request, as any message is", async () => {
  const { looper, said, asked, inputs, mains, answer } = looperWith({
    conversations: "alone",
    routing: (text) => (text === "Stop that." ? stops("a") : []),
  });
  await looper.send("a", "Write a poem.");
  await until(() => asked.length === 1, "its request");
  await looper.send("a", "Stop that.");
  await idle();
  assert.deepEqual(mains, []);
  answer("Write a poem.", sends("Roses are red.", 1));
  await until(() => asked.length === 2, "its next request");
  assert.deepEqual(inputs[1]?.slice(-2), ["Roses are red.", "Stop that."]);
  answer("Stop that.", sends("Stopped."));
  await looper.settled();
  assert.deepEqual(said, [
    "a: user: Write a poem.",
    "a: user: Stop that.",
    "a: assistant: Roses are red.",
    "a: assistant: Stopped.",
  ]);
});

test("alone, a stop heard once the agent was asked again ends nothing: not what it called after reading the message", async () => {
  const scan = held("scan");
  const build = held("build");
  const groups: string[] = [];
  const verdict = gate();
  const { looper, asked, mains, answer } = looperWith({
    conversations: "alone",
    tools: [scan.tool, build.tool],
    stopGroup: async (group) => void groups.push(group),
    routing: async () => {
      await verdict.shut;
      return stops("a");
    },
  });
  await looper.send("a", "Scan everything.");
  await until(() => asked.length === 1, "its request");
  answer("Scan everything.", scan.called);
  await until(() => scan.groups.length === 1, "the scan");
  await looper.send("a", "Stop scanning and build instead.");
  await until(() => mains.length === 1, "it to be heard");
  // The scan ends by itself, and the agent reads the message and builds.
  scan.finish();
  await until(() => asked.length === 2, "its next request");
  answer("Stop scanning and build instead.", build.called);
  await until(() => build.groups.length === 1, "the build");
  verdict.open();
  await idle();
  assert.deepEqual(groups, []);
  build.finish();
  await until(() => asked.length === 3, "its request after the build");
  answer("Stop scanning and build instead.", sends("Built."));
  await looper.settled();
});

test("alone, a hearing that waited behind another conversation's isn't asked once the call it was for has ended", async () => {
  const scan = held("scan");
  const build = held("build");
  const first = gate();
  const { looper, asked, mains, answer } = looperWith({
    conversations: "alone",
    tools: [scan.tool, build.tool],
    routing: async () => {
      await first.shut;
      return [];
    },
  });
  await looper.send("a", "Scan.");
  await looper.send("b", "Build.");
  await until(() => asked.length === 2, "both requests");
  answer("Scan.", scan.called);
  answer("Build.", build.called);
  await until(() => scan.groups.length === 1 && build.groups.length === 1, "both calls");
  await looper.send("a", "How far along?");
  await until(() => mains.length === 1, "the first hearing");
  // Said while the build runs, and heard after the first: the build ends meanwhile.
  await looper.send("b", "And you?");
  build.finish();
  await until(() => asked.length === 3, "the build's next request");
  first.open();
  await idle();
  assert.equal(mains.length, 1);
  answer("And you?", sends("Built."));
  scan.finish();
  await until(() => asked.length === 4, "the scan's next request");
  answer("How far along?", sends("Scanned."));
  await looper.settled();
});

test("alone, a message that asks for nothing is closed with no reply, with its reaction, and steps are kept with status", async () => {
  const { looper, said, asked, reactions, talks, answer } = looperWith({
    conversations: "alone",
  });
  await looper.send("a", "Thanks!");
  await until(() => asked.length === 1, "its request");
  answer("Thanks!", call("no_reply_needed", { message: 1, reaction: "👍" }));
  await looper.settled();
  assert.deepEqual(said, ["a: user: Thanks!"]);
  assert.match(String(reactions[0]), / 👍$/);
  await looper.send("a", "Plan the trip.");
  await until(() => asked.length === 2, "its request");
  answer("Plan the trip.", [
    ...call("status", { steps: [{ text: "Pick dates" }, { text: "Book" }] }),
    ...sends("Started on it."),
  ]);
  await looper.settled();
  // Its own, with nothing passed on: the conversation's own loop is the one listed, with its steps.
  assert.deepEqual(talks, []);
  const [own] = await looper.works(10, 5);
  assert.equal(own?.id, "a");
  assert.deepEqual(
    own?.steps?.map((step) => step.text),
    ["Pick dates", "Book"],
  );
});

test("alone, in a conversation that routed before, it reads what the work there said, and not that work's calls", async () => {
  const { tool } = keeping();
  const before = looperWith({
    conversations: "routes",
    tools: [tool],
    talking: () => passes("The report"),
  });
  await before.looper.send("a", "Write the report.");
  await until(() => before.asked.length === 1, "the work's turn");
  before.answer("Write the report.", call("notes__keep", { text: "draft" }));
  await until(() => before.asked.length === 2, "the work's next request");
  before.answer("Write the report.", sends("Report done: revenue up 4%."));
  await before.looper.settled();
  await before.looper.close();
  const after = looperWith({ values: before.values, conversations: "alone", tools: [tool] });
  await after.looper.send("a", "What did the report say?");
  await until(() => after.asked.length === 1, "its request");
  const input = after.inputs[0] ?? [];
  // The person's message, its own call that passed it on, the work's reply, the new message.
  assert.deepEqual(
    input.filter((line) => !line.startsWith("output ")),
    ["Write the report.", "call route", "Report done: revenue up 4%.", "What did the report say?"],
  );
  assert.ok(!input.some((line) => line.includes("notes__keep") || line.includes("Kept.")));
  after.answer("What did the report say?", sends("Revenue is up 4%."));
  await after.looper.settled();
});

test("alone, in a conversation from before conversations had loops, it reads each message and reply other work held there, and not that work's calls", async () => {
  const { tool } = keeping();
  const before = looperWith({
    tools: [tool],
    routing: (text) => (text === "Book a flight." ? newWork("Flight") : undefined),
  });
  // The thread's first work takes its name, and is the conversation's loop after. It hands the
  // next message back, which starts other work.
  await before.looper.send("a", "Write the report.");
  await until(() => before.asked.length === 1, "the first work's turn");
  before.answer("Write the report.", sends("Report done."));
  await before.looper.settled();
  await before.looper.send("a", "Book a flight.");
  await until(() => before.asked.length === 2, "the first work's next turn");
  before.answer("Book a flight.", handsBack(3));
  await until(() => before.asked.length === 3, "the other work's turn");
  before.answer("Book a flight.", call("notes__keep", { text: "Friday" }));
  await until(() => before.asked.length === 4, "its next request");
  before.answer("Book a flight.", sends("Booked: Friday 9:40."));
  await before.looper.settled();
  // A follow-up the other work takes, as the work last active there.
  await before.looper.send("a", "Make it a window seat.");
  await until(() => before.asked.length === 5, "the other work's next turn");
  before.answer("Make it a window seat.", sends("Window seat it is."));
  await before.looper.settled();
  await before.looper.close();
  const after = looperWith({ values: before.values, conversations: "alone", tools: [tool] });
  await after.looper.send("a", "And the hotel?");
  await until(() => after.asked.length === 1, "its request");
  // Its own, by number, with the call that handed a message back; what the other work said is
  // read in its order, a message it held with no number, as it isn't the agent's to answer; that
  // work's call is not read.
  assert.deepEqual(after.numbered[0], [
    "[1] Write the report.",
    "Report done.",
    "[3] Book a flight.",
    "call hand_back",
    "output Handed back.",
    "Booked: Friday 9:40.",
    "Make it a window seat.",
    "Window seat it is.",
    "[5] And the hotel?",
  ]);
  after.answer("And the hotel?", sends("Looking."));
  await after.looper.settled();
  assert.ok(after.said.includes("a: assistant: Looking."));
});

test("alone, work a routing conversation passed a message to, cut off by a restart, goes on once and answers; the conversation's next message is its own loop's", async () => {
  // Before: a conversation that routes passes the message on to new work, whose turn is cut off.
  const before = looperWith({ conversations: "routes", talking: () => passes("The report") });
  await before.looper.send("a", "Write the report.");
  await until(() => before.asked.length === 1, "the work's turn");
  await before.looper.close();
  // After: the same store, the agent alone. The work goes on with what it held, and answers.
  const after = looperWith({ values: before.values, conversations: "alone" });
  await after.looper.resume();
  await until(() => after.asked.length === 1, "the work going on");
  // It is asked with what it held, the restart said last.
  assert.deepEqual(after.inputs[0]?.[0], "Write the report.");
  assert.match(String(after.asked[0]), /cut off by a restart/);
  after.answer(after.asked[0] as string, sends("Report done.", 1));
  await idle();
  // The next message is the conversation's own loop's, not that work's.
  await after.looper.send("a", "Thanks, and add a chart.");
  await until(() => after.asked.length === 2, "the conversation's request");
  assert.deepEqual(after.inputs[1]?.at(-1), "Thanks, and add a chart.");
  assert.ok(String(after.told[1]?.instructions).endsWith(`\n\n${ALONE}`));
  assert.deepEqual(after.talks, []);
  after.answer("Thanks, and add a chart.", sends("Adding it."));
  await after.looper.settled();
  assert.ok(after.said.includes("a: assistant: Report done."));
  assert.ok(after.said.includes("a: assistant: Adding it."));
});

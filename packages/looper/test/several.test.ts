import assert from "node:assert/strict";
import test from "node:test";
import { workInstructions } from "../src/loop.ts";
import { HEARD_INSTRUCTIONS } from "../src/main.ts";
import {
  gate,
  handsBack,
  held,
  idle,
  looperWith,
  newWork,
  routeTo,
  says,
  sends,
  stops,
  until,
} from "./support.ts";

const BACK = "That was given to this work, which handed it back:";
const works = (values: Map<string, unknown>) =>
  [...values.entries()]
    .filter(([key]) => key.startsWith("work/"))
    .map(([key, value]) => ({ id: decodeURIComponent(key.slice(5)), ...(value as object) })) as {
    id: string;
    title: string;
    follows: string[];
  }[];

/** The number the newest message of a request starts with: the request of the work that began with `first`. */
const numberIn = (numbered: string[][], first: string) => {
  const request = numbered.findLast((lines) => lines[0]?.includes(first));
  const newest = request?.findLast((line) => /^\[\d+\] /.test(line)) ?? "";
  return Number(/^\[(\d+)\]/.exec(newest)?.[1]);
};

/** A report under way in thread `a`, at rest, and a looper whose main loop answers as `routing` says. */
async function reported(
  routing: (
    text: string,
  ) => ReturnType<typeof newWork> | Promise<ReturnType<typeof newWork>> | undefined,
) {
  const made = looperWith({
    routing: (text) => routing(text) ?? newWork("The report"),
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the report's request");
  made.answer("Write the report.", sends("Report done."));
  await made.looper.settled();
  return made;
}

/**
 * Let a few milliseconds pass, so the turn that ends next is last active: a work's time is kept to
 * the millisecond.
 */
const later = () => new Promise((soon) => setTimeout(soon, 5));

/**
 * Thread `a` followed by two pieces of work, each in a turn with its request out: the report,
 * still in its first turn, which handed back a message said as it worked, and the weather, made
 * for that one. Each request ends with "What is the weather?"; the report's began with "Write the
 * report.", and the weather's with "What is the weather?".
 */
async function inTurns(options: Parameters<typeof looperWith>[0] = {}) {
  const made = looperWith({
    ...options,
    routing: (text) =>
      options.routing?.(text) ??
      (text.startsWith(BACK) ? newWork("The weather") : newWork("The report")),
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the report's request");
  // It joins the report's turn, and the main loop hears of it.
  await made.looper.send("a", "What is the weather?");
  await until(() => made.mains.length === 2, "the main loop to hear of it");
  made.answer("Write the report.", []);
  await until(() => made.asked.length === 2, "the report's request that reads both");
  made.answer("What is the weather?", handsBack(numberIn(made.numbered, "report")));
  await until(() => made.asked.length === 4, "the report's turn to go on, and the weather's");
  return made;
}
/** Let the two pieces of work `inTurns` made answer the requests they have out. */
const goOn = (made: Awaited<ReturnType<typeof inTurns>>) => {
  made.answer("What is the weather?", sends("Report done."), "report");
  made.answer("What is the weather?", sends("Sunny."), "weather");
};

test("a worker is told which work it is, reads each message by its number, and is offered the way to hand one back", async () => {
  const { looper, asked, numbered, told, answer } = looperWith({
    routing: () => newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  assert.deepEqual(numbered[0], ["[1] Write the report."]);
  assert.deepEqual(told[0], {
    instructions: workInstructions("The report"),
    tools: ["send", "hand_back"],
  });
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  await looper.send("a", "Shorter.");
  await until(() => asked.length === 2, "the next request");
  assert.deepEqual(numbered[1], ["[1] Write the report.", "Report done.", "[3] Shorter."]);
  await looper.stop();
});

test("a message its thread's work hands back is the main loop's: new work starts for it in the same thread, and says nothing of the handing back", async () => {
  const { looper, values, said, asked, mains, inputs, numbered, answer } = await reported((text) =>
    text.startsWith(BACK)
      ? text.includes(": The weather;")
        ? routeTo("a")
        : newWork("The weather")
      : undefined,
  );
  await looper.send("a", "What is the weather?");
  await until(() => asked.length === 2, "the report's worker to read it");
  answer("What is the weather?", handsBack(3, "It asks about the weather."));
  await until(() => mains.length === 2, "the main loop to be given it");
  // The work that handed it back is not listed, and the main loop is told which did and why.
  assert.deepEqual(mains[1]?.input, [
    "There is no work.",
    "Write the report.",
    "Report done.",
    "What is the weather?",
    `${BACK}\n- a: The report; because: It asks about the weather.`,
  ]);
  await until(() => asked.length === 3, "the new work's request");
  // The report's turn ended there, with no further request and nothing said.
  assert.deepEqual(looper.state("a"), { state: "idle" });
  assert.deepEqual(numbered[2], ["[1] What is the weather?"]);
  await later();
  answer("What is the weather?", sends("Sunny."));
  await looper.settled();
  assert.deepEqual(said, [
    "a: user: Write the report.",
    "a: assistant: Report done.",
    "a: user: What is the weather?",
    "a: assistant: Sunny.",
  ]);
  // Both follow the thread now; the new work has an id of its own.
  const kept = works(values);
  assert.deepEqual(kept.map(({ title, follows }) => [title, follows]).sort(), [
    ["The report", ["a"]],
    ["The weather", ["a"]],
  ]);
  assert.notEqual(kept.find(({ title }) => title === "The weather")?.id, "a");
  // What the person reads of the thread has nothing of the handing back; the report's record
  // has it, for its worker to read next.
  assert.deepEqual(
    (await looper.page("a", undefined, 50)).messages.map((message) => message.text),
    ["Write the report.", "Report done.", "What is the weather?", "Sunny."],
  );
  // The next message there is the weather's, the work last active there. It hands it back, and
  // the main loop gives it to the report.
  await looper.send("a", "Make the report shorter.");
  await until(() => asked.length === 4, "the weather to read it");
  assert.equal(inputs[3]?.[0], "What is the weather?");
  answer("Make the report shorter.", handsBack(numberIn(numbered, "weather"), "The report's."));
  await until(() => asked.length === 5, "the report to read it");
  assert.equal(mains.length, 3);
  assert.deepEqual(
    inputs.slice(3).find((input) => input[0] === "Write the report."),
    [
      "Write the report.",
      "Report done.",
      "What is the weather?",
      "call hand_back",
      "output Handed back.",
      "Make the report shorter.",
    ],
  );
  await looper.stop();
});

test("a message in a thread followed by two pieces of work in a turn reaches both: the one it is for answers, and the other hands it back", async () => {
  const made = await inTurns();
  const { looper, said, asked, mains, inputs, numbered, working, answer } = made;

  // Kept once, and given to each: both take it in their turn, at their next request.
  await looper.send("a", "And tomorrow?");
  goOn(made);
  await until(() => asked.length === 6, "both to read it");
  assert.equal(said.filter((line) => line === "a: user: And tomorrow?").length, 1);
  assert.deepEqual(
    inputs
      .slice(4)
      .map((input) => input[0])
      .sort(),
    ["What is the weather?", "Write the report."],
  );
  // The weather's answers; the report's hands it back. Nothing is put to the main loop, which
  // only heard of it as it joined their turns.
  answer("And tomorrow?", sends("Rain."), "weather");
  await until(() => said.at(-1) === "a: assistant: Rain.", "the weather's reply");
  await later();
  answer(
    "And tomorrow?",
    handsBack(numberIn(numbered, "report"), "It is about the weather."),
    "report",
  );
  // Its turn, which answered the report, goes on once, and ends calling nothing.
  await until(() => asked.length === 7, "the report's turn to go on");
  answer("And tomorrow?", [], "report");
  await looper.settled();
  assert.equal(mains.length, 4);
  assert.equal(mains[3]?.instructions, HEARD_INSTRUCTIONS);
  assert.equal(asked.length, 7);
  assert.equal(said.at(-1), "a: assistant: Rain.");
  // The weather answered it last, so the thread's next message is the weather's alone: the
  // report, which handed it back, starts no turn.
  await looper.send("a", "Thanks.");
  await until(() => asked.length === 8, "the weather to read it");
  await idle();
  assert.equal(asked.length, 8);
  assert.deepEqual(inputs.at(-1)?.slice(0, 1), ["What is the weather?"]);
  assert.equal(inputs.at(-1)?.at(-1), "Thanks.");
  await looper.stop();
  assert.equal(working.at(-1), false);
});

test("a message every piece of work handed back is put to the main loop with who and why; what it answers is no work's", async () => {
  const made = await inTurns({
    routing: (text) =>
      text.startsWith(BACK) && text.includes("The weather")
        ? says("I can't help with that.")
        : undefined,
  });
  const { looper, said, asked, mains, inputs, numbered, answer } = made;

  await looper.send("a", "Book a table for two.");
  goOn(made);
  await until(() => asked.length === 6, "both to read it");
  answer(
    "Book a table for two.",
    handsBack(numberIn(numbered, "report"), "Not the report."),
    "report",
  );
  // Each turn, which answered a message of its own, goes on after handing it back.
  await until(() => asked.length === 7, "the report's turn to go on");
  await idle();
  // Handed back by one of two: it is still the other's. The main loop only heard of it.
  assert.equal(mains.length, 4);
  answer(
    "Book a table for two.",
    handsBack(numberIn(numbered, "weather"), "Not the weather."),
    "weather",
  );
  await until(() => said.at(-1) === "a: assistant: I can't help with that.", "the answer");
  await until(() => asked.length === 8, "the weather's turn to go on");
  const put = mains[4]?.input ?? [];
  assert.equal(put[0], "There is no work.");
  assert.equal(put.at(-2), "Book a table for two.");
  assert.match(String(put.at(-1)), /^That was given to this work, which handed it back:\n- /);
  assert.match(String(put.at(-1)), /The report; because: Not the report\./);
  assert.match(String(put.at(-1)), /The weather; because: Not the weather\./);
  // Neither worker reads what the main loop answered, and the next message, said while both
  // are still in a turn, reaches both again: the main loop only hears of it.
  await looper.send("a", "Thanks.");
  answer("Book a table for two.", [], "report");
  answer("Book a table for two.", [], "weather");
  await until(() => asked.length === 10, "both to read it");
  for (const input of inputs.slice(8)) {
    assert.equal(input.at(-1), "Thanks.");
    assert.equal(input.includes("I can't help with that."), false);
  }
  assert.equal(mains.length, 6);
  assert.equal(mains[5]?.instructions, HEARD_INSTRUCTIONS);
  await looper.stop();
});

test("what came back can be given to work there is, which then follows that thread too; the work that returned it is never named", async () => {
  const { looper, values, said, asked, mains, answer } = looperWith({
    routing: (text) =>
      text.startsWith(BACK)
        ? routeTo("b")
        : text.includes("chart")
          ? newWork("The chart")
          : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the report's request");
  answer("Write the report.", sends("Report done."));
  await looper.send("b", "Draw the chart.");
  await until(() => asked.length === 2, "the chart's request");
  answer("Draw the chart.", sends("Chart done."));
  await looper.settled();
  await looper.send("a", "Make the chart blue.");
  await until(() => asked.length === 3, "the report's worker to read it");
  answer("Make the chart blue.", handsBack(3, "It is about the chart."));
  await until(() => asked.length === 4, "the chart's worker to read it");
  // Only the chart is listed: the report handed it back.
  assert.equal(
    mains[2]?.input[0],
    "The work there is:\n- b: The chart (at rest); it last said: Chart done.",
  );
  answer("Make the chart blue.", sends("Blue now."));
  await looper.settled();
  assert.equal(said.at(-1), "a: assistant: Blue now.");
  assert.deepEqual(
    works(values).map(({ id, follows }) => [id, follows]),
    [
      ["a", ["a"]],
      ["b", ["b", "a"]],
    ],
  );
});

test("a reply one piece of work sends answers the message for every piece it reached", async () => {
  const made = await inTurns();
  const { looper, said, asked, failures, answer } = made;
  // Both read the next, said while both are in a turn; the weather's answers it, and the
  // report's ends saying nothing.
  await looper.send("a", "And tomorrow?");
  goOn(made);
  await until(() => asked.length === 6, "both to read it");
  answer("And tomorrow?", sends("Rain."), "weather");
  await until(() => said.at(-1) === "a: assistant: Rain.", "the reply");
  answer("And tomorrow?", [], "report");
  await looper.settled();
  assert.deepEqual(failures, []);
});

test("a message is handed back once, and only one this work has", async () => {
  const { looper, said, asked, mains, inputs, answer } = await reported((text) =>
    text.startsWith(BACK) ? says("Noted.") : undefined,
  );
  await looper.send("a", "What is the weather?");
  await until(() => asked.length === 2, "the request");
  const refused = JSON.stringify({
    error: {
      code: "invalid",
      message: "No message of this work has that number, or it was handed back already.",
    },
  });
  answer("What is the weather?", [...handsBack(9), ...handsBack(3), ...handsBack(3)]);
  await until(() => asked.length === 3, "the request that reads what they came to");
  assert.deepEqual(inputs[2]?.slice(3), [
    "call hand_back",
    `output ${refused}`,
    "call hand_back",
    "output Handed back.",
    "call hand_back",
    `output ${refused}`,
  ]);
  // A request that writes and calls nothing ends the turn, and says nothing.
  const before = said.length;
  answer("What is the weather?", []);
  await looper.settled();
  assert.equal(said.length, before);
  assert.equal(mains.length, 2);
});

test("work given a thread can leave it as it hands a message back, and never the thread it began in", async () => {
  const { looper, values, asked, mains, inputs, numbered, failures, answer } = looperWith({
    routing: (text) =>
      text.startsWith(BACK) || text === "Anyone?"
        ? says("Noted.")
        : text === "Add a chart to the report."
          ? routeTo("a")
          : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the report's request");
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  await looper.send("b", "Add a chart to the report.");
  await until(() => asked.length === 2, "the request that reads it");
  // It leaves the thread it was given; asked to leave its own, it stays.
  answer("Add a chart to the report.", [...handsBack(3, "Not mine.", true)]);
  await looper.settled();
  assert.deepEqual(values.get("work/a"), {
    ...(values.get("work/a") as object),
    follows: ["a", "b"],
    left: ["b"],
  });
  assert.equal(values.get("unrouted/b"), false);
  assert.deepEqual(failures, []);
  // A message there is the main loop's again, and one in its own thread still reads what it
  // held of the thread it left.
  await looper.send("b", "Anyone?");
  await until(() => mains.length === 4, "the main loop to be asked");
  // What it answered before is decided: it is put the thread as it stands, with no note.
  assert.deepEqual(mains[3]?.input.slice(1), ["Add a chart to the report.", "Noted.", "Anyone?"]);
  await looper.send("a", "And this?");
  await until(() => asked.length === 3, "the request");
  answer("And this?", handsBack(numberIn(numbered, "report"), "Not mine either.", true));
  await looper.settled();
  assert.deepEqual((values.get("work/a") as { left: string[] }).left, ["b"]);
  assert.deepEqual(inputs[2]?.slice(2, 5), [
    "Add a chart to the report.",
    "call hand_back",
    "output Handed back. This work no longer follows that conversation.",
  ]);
  assert.deepEqual(failures, []);
  await looper.stop();
});

test("with two pieces of work in a turn, the main loop hears of a message once, with both, and what it says of which are in a turn is no work's", async () => {
  const made = await inTurns({
    routing: (text) =>
      text === "Stop."
        ? says("The report and the weather are both in a turn. Which one?")
        : undefined,
  });
  const { looper, said, asked, mains, inputs } = made;
  const weather = inputs.findIndex((input) => input[0] === "What is the weather?");
  assert.ok(weather >= 0);

  await looper.send("a", "Stop.");
  await until(() => mains.length === 4, "the main loop to hear of it");
  assert.equal(mains[3]?.instructions, HEARD_INSTRUCTIONS);
  assert.match(
    String(mains[3]?.input[0]),
    /^The work there is:\n- .*: The report \(in a turn\)\n- .*: The weather \(in a turn\)$/,
  );
  await until(
    () => said.at(-1)?.startsWith("a: assistant: The report and the weather") === true,
    "what it says",
  );
  // Heard once, nothing was stopped, and neither worker reads that line.
  await idle();
  assert.equal(mains.length, 4);
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  goOn(made);
  await until(() => asked.length === 6, "both to read the stop");
  for (const input of inputs.slice(4))
    assert.equal(
      input.some((line) => line.includes("Which one?")),
      false,
    );
  await looper.stop();
});

test("with two pieces of work in a turn, a message that names one to stop stops that one, and the other goes on", async () => {
  let weather = "";
  const { looper, values, said, asked, inputs, numbered, answer } = await inTurns({
    routing: (text) =>
      text === "Stop the weather."
        ? [...says("Stopped the weather."), ...stops(weather)]
        : text.startsWith(BACK) && text.includes("The weather's.")
          ? routeTo(weather)
          : undefined,
  });
  weather = works(values).find(({ title }) => title === "The weather")?.id ?? "";
  await looper.send("a", "Stop the weather.");
  await until(() => said.at(-1) === "a: assistant: Stopped the weather.", "the thread to be told");
  assert.deepEqual(looper.state(weather), { state: "idle" });
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  // What the main loop said is the stopped work's to read next, and not the other's.
  answer("What is the weather?", sends("Report goes on."), "report");
  await until(() => asked.length === 5, "the report to read the stop");
  assert.equal(inputs[4]?.includes("Stopped the weather."), false);
  await later();
  answer("Stop the weather.", sends("Still on the report."), "report");
  await looper.settled();
  // The next is the report's, the work last active there, which hands it back: the main loop
  // gives it to the weather, which reads it after the line it was stopped with.
  await looper.send("a", "Weather again, please.");
  await until(() => asked.length === 6, "the report to read it");
  answer(
    "Weather again, please.",
    handsBack(numberIn(numbered, "report"), "The weather's."),
    "report",
  );
  await until(() => asked.length === 7, "the weather to read it");
  assert.deepEqual(inputs.findLast((input) => input[0] === "What is the weather?")?.slice(-4), [
    "What is the weather?",
    "Stop the weather.",
    "Stopped the weather.",
    "Weather again, please.",
  ]);
  await looper.stop();
});

test("a message that came back while the looper was stopped is decided with the thread's next message", async () => {
  let held = true;
  const { looper, said, asked, mains, answer } = await reported((text) =>
    text.startsWith(BACK) ? (held ? new Promise(() => {}) : says("I can't tell.")) : undefined,
  );
  await looper.send("a", "What is the weather?");
  await until(() => asked.length === 2, "the request");
  answer("What is the weather?", handsBack(3));
  await until(() => mains.length === 2, "the main loop to be given it");
  await looper.stop();
  held = false;
  looper.start();
  await idle();
  assert.equal(mains.length, 2);
  // The next message there is its work's; what came back is put to the main loop then.
  await looper.send("a", "And the report?");
  await until(() => said.includes("a: assistant: I can't tell."), "the answer to what came back");
  assert.equal(mains.length, 3);
  assert.equal(mains[2]?.input.at(-2), "What is the weather?");
  await until(() => asked.length === 3, "the report's request");
  await looper.stop();
});

test("a thread from before work could be handed back keeps its messages its own work's when new work joins it", async () => {
  const first = looperWith();
  await first.looper.send("a", "Write the report.");
  await until(() => first.asked.length === 1, "the request");
  first.answer("Write the report.", sends("Report done."));
  await first.looper.settled();
  // As kept before: its messages name no work, and it has no record of its own.
  first.values.delete("work/a");
  const before = JSON.stringify([...first.values].filter(([key]) => key.startsWith("thread/a/")));

  const { looper, values, asked, numbered, answer } = looperWith({
    values: first.values,
    routing: (text) => (text.startsWith(BACK) ? newWork("The weather") : newWork()),
  });
  await looper.send("a", "What is the weather?");
  await until(() => asked.length === 1, "its own work's request");
  answer("What is the weather?", handsBack(3, "About the weather."));
  await until(() => asked.length === 2, "the new work's request");
  assert.deepEqual(numbered[1], ["[1] What is the weather?"]);
  answer("What is the weather?", sends("Sunny."));
  await looper.settled();
  assert.equal(
    JSON.stringify([...values].filter(([key]) => /^thread\/a\/msg\/00000000000[12]$/.test(key))),
    before,
  );
  assert.deepEqual(
    works(values)
      .map(({ title, follows }) => [title, follows])
      .sort(),
    [
      ["The weather", ["a"]],
      ["Write the report.", ["a"]],
    ],
  );
});

test("a hand-back the store refuses hands nothing back, and the worker is told so", async () => {
  let refusing = false;
  const { looper, values, asked, mains, inputs, answer } = looperWith({
    writing: (key) =>
      refusing && key === "thread/a/msg/000000000003"
        ? Promise.reject(new Error("the store refused it"))
        : undefined,
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the request");
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  await looper.send("a", "What is the weather?");
  await until(() => asked.length === 2, "the request");
  refusing = true;
  answer("What is the weather?", handsBack(3));
  await until(() => asked.length === 3, "the request that reads what came of it");
  assert.match(String(inputs[2]?.at(-1)), /^output \{"error":/);
  assert.equal((values.get("thread/a/msg/000000000003") as { to?: unknown }).to, undefined);
  answer("What is the weather?", sends("I can't say."));
  await looper.settled();
  assert.equal(mains.length, 1);
});

/**
 * Thread `a` followed by two pieces of work at rest: the report, and the weather, which was
 * active last.
 */
async function two(options: Parameters<typeof looperWith>[0] = {}) {
  const made = looperWith({
    ...options,
    routing: (text) =>
      options.routing?.(text) ??
      (text.startsWith(BACK) ? newWork("The weather") : newWork("The report")),
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the report's request");
  made.answer("Write the report.", sends("Report done."));
  await made.looper.settled();
  await made.looper.send("a", "What is the weather?");
  await until(() => made.asked.length === 2, "the report's worker to read it");
  made.answer("What is the weather?", handsBack(3));
  await until(() => made.asked.length === 3, "the weather's request");
  await later();
  made.answer("What is the weather?", sends("Sunny."));
  await made.looper.settled();
  return made;
}
/** How often each of a thread's works was sent `text`, in the requests from `from` on. */
const readBy = (inputs: string[][], from: number, text: string) =>
  inputs
    .slice(from)
    .filter((input) => input.includes(text))
    .map((input) => input[0])
    .sort();

test("a message in a thread whose pieces of work are all at rest goes to the one last active, and the others start no turn", async () => {
  const { looper, values, said, asked, mains, inputs, numbered, answer } = await two({
    routing: (text) =>
      text.startsWith(BACK) && text.includes(": The weather;") ? routeTo("a") : undefined,
  });
  const weather = works(values).find(({ title }) => title === "The weather")?.id ?? "";
  // The weather was active last: it alone reads the next, as its own, and nothing is put to the
  // main loop.
  await looper.send("a", "And tomorrow?");
  await until(() => asked.length === 4, "the weather to read it");
  await idle();
  assert.equal(asked.length, 4);
  assert.deepEqual(numbered[3], ["[1] What is the weather?", "Sunny.", "[3] And tomorrow?"]);
  assert.deepEqual(looper.state(weather), { state: "thinking" });
  assert.deepEqual(looper.state("a"), { state: "idle" });
  assert.equal(mains.length, 2);
  answer("And tomorrow?", sends("Rain."));
  await looper.settled();
  // It hands the next back, and the main loop gives it to the report, which is then the one
  // last active there.
  await looper.send("a", "Make the report shorter.");
  await until(() => asked.length === 5, "the weather to read it");
  answer("Make the report shorter.", handsBack(numberIn(numbered, "weather"), "The report's."));
  await until(() => asked.length === 6, "the report to read it");
  await later();
  answer("Make the report shorter.", sends("Shorter now."), "report");
  await looper.settled();
  await looper.send("a", "Thanks.");
  await until(() => asked.length === 7, "the report to read it");
  await idle();
  assert.equal(asked.length, 7);
  assert.equal(inputs[6]?.[0], "Write the report.");
  assert.equal(inputs[6]?.at(-1), "Thanks.");
  assert.deepEqual(looper.state(weather), { state: "idle" });
  assert.equal(said.filter((line) => line === "a: user: Thanks.").length, 1);
  await looper.stop();
});

test("a message that comes back while the main loop decides on another in its thread is decided next", async () => {
  const hold = gate();
  let decisions = 0;
  const { looper, asked, mains, numbered, answer } = await reported((text) => {
    if (!text.startsWith(BACK)) return undefined;
    const n = ++decisions;
    return (n === 1 ? hold.shut : Promise.resolve()).then(() => says(`Answer ${n}.`));
  });
  await looper.send("a", "What is the weather?");
  await until(() => asked.length === 2, "the request");
  answer("What is the weather?", handsBack(3, "The weather."));
  await until(() => mains.length === 2, "the decision to be out");
  await looper.send("a", "Book a table.");
  await until(() => asked.length === 3, "the request");
  answer("Book a table.", handsBack(numberIn(numbered, "report"), "A table."));
  await idle();
  hold.open();
  await looper.settled();
  assert.deepEqual(
    mains.slice(1).map(({ input }) => input.at(-1)),
    [
      `${BACK}\n- a: The report; because: The weather.`,
      `${BACK}\n- a: The report; because: A table.`,
    ],
  );
  assert.equal(mains[2]?.input.at(-2), "Book a table.");
});

test("a looper stopped or closed between two pieces of work taking a message starts no turn after, and the rest take it later", async () => {
  for (const end of ["stop", "close"] as const) {
    let writes = 0;
    let armed = false;
    let marked = false;
    const mark = gate();
    const hold = gate();
    const made = await inTurns({
      // The thread is marked once both are found to take it. The message's first write keeps
      // it, after the weather's reply; its second is the first of the two taking it.
      writing: (key) => {
        if (!armed) return undefined;
        if (key === "unrouted/a" && !marked) {
          marked = true;
          return mark.shut;
        }
        return key === "thread/a/msg/000000000005" && ++writes === 2 ? hold.shut : undefined;
      },
    });
    const { looper, values, said, asked, inputs, answer } = made;
    armed = true;
    const sending = looper.send("a", "Both, go on.");
    await until(() => marked, "both to be found to take it");
    // The weather's turn ends meanwhile, with a reply, so it is the work last active there:
    // taking the message, it would start a turn. The report's turn is cut after.
    answer("What is the weather?", sends("Sunny."), "weather");
    await until(() => said.at(-1) === "a: assistant: Sunny.", "the weather's reply");
    await later();
    mark.open();
    await until(() => writes === 2, "the first to be taking it");
    const ending = looper[end]();
    await idle();
    hold.open();
    await ending;
    await sending;
    await idle();
    assert.equal(asked.length, 4, end);
    if (end === "stop") {
      // Started again, the thread's next message goes to the weather, which answered there last,
      // and it takes the one that waited for it too; the report, which took that one before the
      // stop, starts no turn.
      looper.start();
      await looper.send("a", "And now?");
      await until(() => asked.length === 5, "the weather to read them");
      await idle();
      assert.equal(asked.length, 5, end);
      assert.deepEqual(
        inputs.slice(4).map((input) => [input[0], ...input.slice(-3)]),
        [["What is the weather?", "Sunny.", "Both, go on.", "And now?"]],
        end,
      );
      await looper.stop();
    } else {
      // The next looper goes on with it: each reads it once.
      const next = looperWith({ values });
      await next.looper.resume();
      await until(() => next.asked.length === 2, "both to read it");
      assert.deepEqual(readBy(next.inputs, 0, "Both, go on."), [
        "What is the weather?",
        "Write the report.",
      ]);
      await next.looper.stop();
    }
  }
});

test("a message goes to the work in a turn, not to the work at rest that answered there last", async () => {
  const made = await inTurns();
  const { looper, asked, inputs, said, answer } = made;
  // The weather answers and rests, last active there; the report is still in its turn.
  answer("What is the weather?", sends("Sunny."), "weather");
  await until(() => said.at(-1) === "a: assistant: Sunny.", "the weather's reply");
  await idle();
  const before = asked.length;
  await looper.send("a", "Add the forecast to the report.");
  answer("What is the weather?", sends("Report done."), "report");
  await until(() => asked.length === before + 1, "the report to read it");
  await idle();
  assert.equal(asked.length, before + 1);
  assert.equal(inputs.at(-1)?.[0], "Write the report.");
  assert.equal(inputs.at(-1)?.at(-1), "Add the forecast to the report.");
  await looper.stop();
});

test("a message one of its works can't take is kept and told to have failed for it, and that work takes it with its next", async () => {
  let refusing = false;
  let writes = 0;
  const { looper, asked, inputs, failures, answer } = await inTurns({
    // The second taking of the message is refused once.
    writing: (key) =>
      refusing && key === "thread/a/msg/000000000004" && ++writes === 3
        ? Promise.reject(new Error("the store refused it"))
        : undefined,
  });
  refusing = true;
  const { messageId } = await looper.send("a", "Both, go on.");
  assert.ok(messageId);
  // The report took it, and reads it at its next request.
  answer("What is the weather?", sends("Report done."), "report");
  await until(() => asked.length === 5, "the one that took it");
  await idle();
  assert.equal(asked.length, 5);
  assert.equal(failures.length, 1);
  answer("Both, go on.", sends("Went on."));
  // The weather takes it with what it keeps next: its reply to what it was at.
  answer("What is the weather?", sends("Sunny."), "weather");
  await until(() => asked.length === 6, "the weather to read it");
  assert.deepEqual(readBy(inputs, 4, "Both, go on."), [
    "What is the weather?",
    "Write the report.",
  ]);
  await looper.stop();
});

test("a turn reads a message it took though another piece of work is still taking that message", async () => {
  let armed = false;
  let writes = 0;
  const hold = gate();
  const { looper, asked, inputs, answer } = await inTurns({
    // The third write of the message is the second piece of work taking it.
    writing: (key) =>
      armed && key === "thread/a/msg/000000000004" && ++writes === 3 ? hold.shut : undefined,
  });
  armed = true;
  const sending = looper.send("a", "Also add a summary.");
  await until(() => writes === 3, "the weather to be taking it");
  // The report's request, which had not read it, answers while that write is out.
  answer("What is the weather?", sends("Shortened."), "report");
  await until(() => asked.length === 5, "the report's turn to go on");
  assert.deepEqual(inputs[4]?.slice(-3), [
    "output Handed back.",
    "Shortened.",
    "Also add a summary.",
  ]);
  hold.open();
  await sending;
  await looper.stop();
});

test("a worker that hands back a message said while it works on another goes on with its work", async () => {
  const { looper, said, asked, mains, inputs, numbered, answer } = await reported((text) =>
    text.startsWith(BACK) ? says("Not something I can do.") : undefined,
  );
  await looper.send("a", "Make the report shorter.");
  await until(() => asked.length === 2, "the request");
  await looper.send("a", "Book a table.");
  // Its request that reads both hands the second back, and calls nothing else.
  answer("Make the report shorter.", []);
  await until(() => asked.length === 3, "the request that reads both");
  answer("Book a table.", handsBack(numberIn(numbered, "report"), "Not the report."));
  // The first is still unanswered: the turn goes on, and what it then writes is its reply.
  await until(() => asked.length === 4, "the turn to go on");
  assert.deepEqual(inputs[3]?.slice(-4), [
    "Make the report shorter.",
    "Book a table.",
    "call hand_back",
    "output Handed back.",
  ]);
  answer("Book a table.", sends("Shorter now."));
  await until(() => said.includes("a: assistant: Not something I can do."), "the main loop");
  await looper.settled();
  assert.equal(said.includes("a: assistant: Shorter now."), true);
  assert.equal(mains.length, 3);
});

test("a hand-back with no number or no reason hands nothing back, and the worker is told so", async () => {
  const { looper, asked, mains, inputs, answer } = await reported(() => undefined);
  await looper.send("a", "What is the weather?");
  await until(() => asked.length === 2, "the request");
  answer("What is the weather?", [
    { type: "function_call", callId: "b1", name: "hand_back", arguments: '{"message":3}' },
    { type: "function_call", callId: "b2", name: "hand_back", arguments: '{"why":"Not mine."}' },
  ]);
  await until(() => asked.length === 3, "the request that reads what they came to");
  for (const line of inputs[2]?.slice(-3).filter((one) => one.startsWith("output")) ?? [])
    assert.match(line, /Give the message's number and one sentence why\./);
  answer("What is the weather?", sends("I can't say."));
  await looper.settled();
  assert.equal(mains.length, 1);
});

test("a hand-back alone doesn't end a turn that has a message of its own turn still unanswered", async () => {
  const { looper, said, asked, numbered, answer } = await reported((text) =>
    text.startsWith(BACK) ? says("Noted.") : undefined,
  );
  await looper.send("a", "Shorten it.");
  await until(() => asked.length === 2, "the request");
  await looper.send("a", "Book a table.");
  await looper.send("a", "And add a summary.");
  answer("Shorten it.", sends("Shortened."));
  await until(() => asked.length === 3, "the request that reads both");
  const table = Number(
    /^\[(\d+)\] Book a table\.$/.exec(
      numbered[2]?.find((line) => line.endsWith("Book a table.")) ?? "",
    )?.[1],
  );
  answer("And add a summary.", handsBack(table, "Not the report."));
  await until(() => asked.length === 4, "the turn to go on with the summary");
  answer("And add a summary.", sends("Summary added."));
  await looper.settled();
  assert.equal(said.includes("a: assistant: Summary added."), true);
});

test("new work for a message that came back where nothing follows reads it before one said after it", async () => {
  const hold = gate();
  const { looper, asked, numbered, answer } = looperWith({
    routing: (text) =>
      text.startsWith(BACK)
        ? hold.shut.then(() => newWork("The weather"))
        : text === "Add a chart to the report."
          ? routeTo("a")
          : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the report's request");
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  await looper.send("b", "Add a chart to the report.");
  await until(() => asked.length === 2, "the request that reads it");
  answer("Add a chart to the report.", sends("Chart added."));
  await looper.settled();
  await looper.send("b", "What is the weather?");
  await until(() => asked.length === 3, "the request that reads it");
  answer("What is the weather?", handsBack(numberIn(numbered, "report"), "Not the report.", true));
  await idle();
  // Said while the main loop decides on what came back, in a thread nothing follows now.
  await looper.send("b", "And is it windy?");
  hold.open();
  await until(() => asked.length === 4, "the new work's request");
  assert.deepEqual(numbered[3], ["[1] What is the weather?", "[2] And is it windy?"]);
  await looper.stop();
});

test("a message said where nothing follows, before the main loop decides on one that came back there, is decided next", async () => {
  const hold = gate();
  const { looper, said, asked, mains, numbered, answer } = looperWith({
    routing: (text) =>
      text.startsWith(BACK)
        ? says("Nobody does that.")
        : text === "Hold on."
          ? hold.shut.then(() => says("Held."))
          : text === "Add a chart to the report."
            ? routeTo("a")
            : text === "Anyone there?"
              ? says("Here.")
              : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the report's request");
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  await looper.send("b", "Add a chart to the report.");
  await until(() => asked.length === 2, "the request that reads it");
  answer("Add a chart to the report.", sends("Chart added."));
  await looper.settled();
  // The main loop is busy with another thread while the work leaves and the next is said.
  await looper.send("z", "Hold on.");
  await until(() => mains.length === 3, "the decision that holds");
  await looper.send("b", "Book a table.");
  await until(() => asked.length === 3, "the request that reads it");
  answer("Book a table.", handsBack(numberIn(numbered, "report"), "Not the report.", true));
  await idle();
  await looper.send("b", "Anyone there?");
  hold.open();
  await until(() => said.includes("b: assistant: Here."), "the later message's answer");
  await looper.settled();
  assert.deepEqual(said.filter((line) => line.startsWith("b: ")).slice(-4), [
    "b: user: Book a table.",
    "b: user: Anyone there?",
    "b: assistant: Nobody does that.",
    "b: assistant: Here.",
  ]);
});

test("two messages said one after the other reach each piece of work in that order, though the first is stored late", async () => {
  let writes = 0;
  let armed = false;
  const hold = gate();
  const made = await inTurns({
    writing: (key) =>
      armed && key === "thread/a/msg/000000000004" && ++writes === 1 ? hold.shut : undefined,
  });
  const { looper, asked, inputs, answer } = made;
  armed = true;
  const sending = [looper.send("a", "First."), looper.send("a", "Second.")];
  await idle();
  hold.open();
  await Promise.all(sending);
  // Both are said while both pieces of work are in a turn: each reads them at its next request.
  goOn(made);
  await until(() => asked.length === 6, "both to read them");
  for (const input of inputs.slice(4)) {
    assert.ok(input.indexOf("First.") >= 0);
    assert.ok(input.indexOf("First.") < input.indexOf("Second."));
  }
  for (let round = 0; round < 3; round++) {
    for (const text of ["First.", "Second."])
      for (const of of ["report", "weather"]) answer(text, sends("ok"), of);
    await idle();
  }
  await looper.settled();
  // The work last active there reads the third after them, as its record keeps them.
  const before = asked.length;
  await looper.send("a", "Third.");
  await until(() => asked.length === before + 1, "the work last active to read the third");
  for (const input of inputs.slice(before)) {
    assert.ok(input.indexOf("First.") >= 0);
    assert.ok(input.indexOf("First.") < input.indexOf("Second."));
  }
  await looper.stop();
});

/** The number a worker's request gives the message that says `text`. */
const numberOf = (lines: string[] | undefined, text: string) =>
  Number(/^\[(\d+)\] /.exec(lines?.find((line) => line.endsWith(`] ${text}`)) ?? "")?.[1]);

test("a worker at a task, having said it is looking, that hands back a message said meanwhile goes on with the task", async () => {
  const { tool, called, groups, finish } = held();
  const { looper, said, asked, mains, numbered, answer } = looperWith({
    tools: [tool],
    routing: (text) => (text.startsWith(BACK) ? says("Nobody does that.") : newWork("The report")),
  });
  await looper.send("a", "Make the report shorter.");
  await until(() => asked.length === 1, "the request");
  answer("Make the report shorter.", [...sends("Let me look."), ...called]);
  await until(() => groups.length === 1, "the call to start");
  await looper.send("a", "Book a table.");
  finish();
  await until(() => asked.length === 2, "the request that reads it");
  answer("Book a table.", handsBack(numberOf(numbered[1], "Book a table."), "Not the report."));
  // The task is not done: the turn asks again, and what it then writes is the task's answer.
  await until(() => asked.length === 3, "the turn to go on");
  answer("Book a table.", sends("Shorter now."));
  await looper.settled();
  assert.equal(said.includes("a: assistant: Shorter now."), true);
  assert.equal(said.includes("a: assistant: Nobody does that."), true);
  // The first decision, the hearing of the message that joined the turn, and what came back.
  assert.equal(mains.length, 3);
});

test("a worker that hands back a message from another thread answers its task where the task was asked", async () => {
  const { tool, called, groups, finish } = held();
  const { looper, said, asked, numbered, answer } = looperWith({
    tools: [tool],
    routing: (text) =>
      text.startsWith(BACK)
        ? says("Nobody does that.")
        : text === "Add a chart to the report."
          ? routeTo("a")
          : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the report's request");
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  await looper.send("b", "Add a chart to the report.");
  await until(() => asked.length === 2, "the request that reads it");
  answer("Add a chart to the report.", sends("Chart added."));
  await looper.settled();
  await looper.send("a", "Make it shorter.");
  await until(() => asked.length === 3, "the task's request");
  answer("Make it shorter.", called);
  await until(() => groups.length === 1, "the call to start");
  await looper.send("b", "Book a table.");
  finish();
  await until(() => asked.length === 4, "the request that reads it");
  answer("Book a table.", handsBack(numberOf(numbered[3], "Book a table."), "Not the report."));
  await until(() => asked.length === 5, "the turn to go on");
  answer("Book a table.", sends("Shorter now."));
  await looper.settled();
  assert.equal(said.includes("a: assistant: Shorter now."), true);
  assert.equal(said.includes("b: assistant: Shorter now."), false);
});

test("work that left a thread takes nothing said there after, and writes nothing more there", async () => {
  const { tool, called, groups, finish } = held();
  const { looper, said, asked, inputs, numbered, answer } = looperWith({
    tools: [tool],
    routing: (text) =>
      text.startsWith(BACK)
        ? says("Nobody does that.")
        : text === "Add a chart to the report."
          ? routeTo("a")
          : text === "Anyone?"
            ? says("Here.")
            : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the report's request");
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  await looper.send("b", "Add a chart to the report.");
  await until(() => asked.length === 2, "the request that reads it");
  answer("Add a chart to the report.", sends("Chart added."));
  await looper.settled();
  // In the middle of a task from its own thread, it leaves the other with two messages of it.
  await looper.send("a", "Make it shorter.");
  await until(() => asked.length === 3, "the task's request");
  answer("Make it shorter.", called);
  await until(() => groups.length === 1, "the call to start");
  await looper.send("b", "Book a table.");
  await looper.send("b", "And a taxi.");
  finish();
  await until(() => asked.length === 4, "the request that reads them");
  answer("And a taxi.", [
    ...handsBack(numberOf(numbered[3], "Book a table."), "Not the report.", true),
    ...handsBack(numberOf(numbered[3], "And a taxi."), "Not the report.", true),
  ]);
  await until(() => asked.length === 5, "the turn to go on");
  // It left with the first; the second says only that it is handed back.
  assert.deepEqual(
    inputs[4]?.filter((line) => line.startsWith("output Handed back")),
    ["output Handed back. This work no longer follows that conversation.", "output Handed back."],
  );
  await until(() => said.includes("b: assistant: Nobody does that."), "the main loop's answer");
  await looper.send("b", "Anyone?");
  await until(() => said.includes("b: assistant: Here."), "the main loop's answer");
  answer("And a taxi.", sends("Shorter now."));
  await looper.settled();
  assert.equal(said.includes("a: assistant: Shorter now."), true);
  // Each of the two that came back is decided, then the message said after.
  assert.deepEqual(said.filter((line) => line.startsWith("b: ")).slice(-6), [
    "b: user: Book a table.",
    "b: user: And a taxi.",
    "b: assistant: Nobody does that.",
    "b: assistant: Nobody does that.",
    "b: user: Anyone?",
    "b: assistant: Here.",
  ]);
  await looper.send("a", "Thanks.");
  await until(() => asked.length === 6, "its next request");
  assert.equal(inputs[5]?.includes("Anyone?"), false);
  assert.equal(inputs[5]?.includes("Here."), false);
  await looper.stop();
});

test("a store left as a message was being given to two pieces of work has the next looper give it to both, once", async () => {
  // Both are in a turn. Left as the first of the two begins to take it, and left after that one
  // has taken it, as the second begins to.
  const points: ((key: string, count: (key: string) => number) => boolean)[] = [
    (key, count) => key === "thread/a/msg/000000000004" && count(key) === 2,
    (key, count) => key === "thread/a/msg/000000000004" && count(key) === 3,
  ];
  for (const [n, at] of points.entries()) {
    const values = new Map<string, never>();
    let left: Map<string, never> | undefined;
    const counts = new Map<string, number>();
    let armed = false;
    const { looper } = await inTurns({
      values,
      writing: (key) => {
        if (!armed || left) return undefined;
        const group = key.startsWith("unfinished/") ? "unfinished/" : key;
        counts.set(group, (counts.get(group) ?? 0) + 1);
        if (at(key, (one) => counts.get(one) ?? 0)) left = new Map(values);
        return undefined;
      },
    });
    armed = true;
    await looper.send("a", "Both, go on.");
    await until(() => left !== undefined, `the store as it was left (${n})`);
    await looper.stop();

    const next = looperWith({ values: left as Map<string, never> });
    await next.looper.resume();
    await until(() => next.asked.length === 2, `both to read it (${n})`);
    assert.deepEqual(readBy(next.inputs, 0, "Both, go on."), [
      "What is the weather?",
      "Write the report.",
    ]);
    await next.looper.stop();
  }
});

test("a thread is marked before a message says it was handed back, and a store left right after has the next looper decide on it", async () => {
  const values = new Map<string, never>();
  const order: string[] = [];
  let left: Map<string, never> | undefined;
  let handed = false;
  const made = looperWith({
    values,
    writing: (key) => {
      order.push(key);
      // The first write after the message says it was handed back: the process is gone there.
      if (handed && !left && key !== "thread/a/msg/000000000003") left = new Map(values);
      if (key === "thread/a/msg/000000000003" && order.filter((one) => one === key).length === 2)
        handed = true;
      return undefined;
    },
    routing: (text) => (text.startsWith(BACK) ? new Promise(() => {}) : newWork("The report")),
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", sends("Report done."));
  await made.looper.settled();
  await made.looper.send("a", "What is the weather?");
  await until(() => made.asked.length === 2, "the request");
  const from = order.length;
  made.answer("What is the weather?", handsBack(3));
  await until(() => left !== undefined, "the store as it was left");
  const since = order.slice(from);
  assert.ok(since.indexOf("unrouted/a") >= 0);
  assert.ok(since.indexOf("unrouted/a") < since.lastIndexOf("thread/a/msg/000000000003"));
  await made.looper.close();

  const next = looperWith({
    values: left as Map<string, never>,
    routing: (text) => (text.startsWith(BACK) ? says("Nobody does that.") : newWork()),
  });
  await next.looper.resume();
  await until(() => next.said.includes("a: assistant: Nobody does that."), "the decision");
  assert.equal(next.mains.length, 1);
  await next.looper.stop();
});

test("the main loop's answer to what came back decides it in the same write: a store left right after is not decided again", async () => {
  const values = new Map<string, never>();
  let left: Map<string, never> | undefined;
  const made = looperWith({
    values,
    // As the answer is said, it is stored and the thread's mark still stands.
    saying: (line) => {
      if (line === "a: assistant: Nobody does that.") left = new Map(values);
    },
    routing: (text) => (text.startsWith(BACK) ? says("Nobody does that.") : newWork("The report")),
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", sends("Report done."));
  await made.looper.settled();
  await made.looper.send("a", "What is the weather?");
  await until(() => made.asked.length === 2, "the request");
  made.answer("What is the weather?", handsBack(3));
  await until(() => left !== undefined, "the store as it was left");
  await made.looper.settled();
  assert.equal(left?.get("unrouted/a"), true);

  const next = looperWith({ values: left as Map<string, never> });
  await next.looper.resume();
  await idle();
  await next.looper.settled();
  assert.deepEqual(next.mains, []);
  assert.deepEqual(next.said, []);
  assert.equal(next.values.has("unrouted/a"), false);
});

test("a store left after the main loop gave what came back to new work, and before that work was kept, has the next looper start it", async () => {
  const values = new Map<string, never>();
  let left: Map<string, never> | undefined;
  const made = looperWith({
    values,
    // The new work's record is about to be written: the message already names it, with its title.
    writing: (key) => {
      if (!left && key.startsWith("work/") && key !== "work/a") left = new Map(values);
      return undefined;
    },
    routing: (text) => (text.startsWith(BACK) ? newWork("The weather") : newWork("The report")),
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", sends("Report done."));
  await made.looper.settled();
  await made.looper.send("a", "What is the weather?");
  await until(() => made.asked.length === 2, "the request");
  made.answer("What is the weather?", handsBack(3));
  await until(() => left !== undefined, "the store as it was left");
  await made.looper.stop();
  assert.deepEqual(
    [...(left as Map<string, never>).keys()].filter((key) => key.startsWith("work/")),
    ["work/a"],
  );

  const next = looperWith({ values: left as Map<string, never> });
  await next.looper.resume();
  await until(
    () => next.numbered.some((lines) => lines[0] === "[1] What is the weather?"),
    "the new work's request",
  );
  // The decision stands as it was made: the main loop is not asked again.
  assert.deepEqual(next.mains, []);
  assert.deepEqual(
    works(next.values)
      .map(({ title, follows }) => [title, follows])
      .sort(),
    [
      ["The report", ["a"]],
      ["The weather", ["a"]],
    ],
  );
  await next.looper.stop();
});

test("a thread stays marked while the main loop decides on a message two pieces of work handed back together", async () => {
  const made = await inTurns({
    routing: (text) =>
      text.startsWith(BACK) && text.includes("A table.") ? new Promise(() => {}) : undefined,
  });
  const { looper, values, asked, mains, numbered, answer } = made;
  await looper.send("a", "Book a table.");
  goOn(made);
  await until(() => asked.length === 6, "both to read it");
  answer("Book a table.", handsBack(numberIn(numbered, "report"), "A table."), "report");
  answer("Book a table.", handsBack(numberIn(numbered, "weather"), "A table."), "weather");
  // Heard of as it joined their turns, then given to decide.
  await until(() => mains.length === 5, "the main loop to be given it");
  await idle();
  assert.equal(values.get("unrouted/a"), true);
  await looper.close();
});

test("a placement whose new work the store refuses to keep is finished with the thread's next message, and not decided again", async () => {
  let refuse = true;
  const { looper, asked, mains, numbered, failures, answer } = looperWith({
    writing: (key) => {
      if (!refuse || !key.startsWith("work/") || key === "work/a") return undefined;
      refuse = false;
      return Promise.reject(new Error("the store refused it"));
    },
    routing: (text) => (text.startsWith(BACK) ? newWork("The weather") : newWork("The report")),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the report's request");
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  await looper.send("a", "What is the weather?");
  await until(() => asked.length === 2, "the request");
  answer("What is the weather?", handsBack(3));
  await until(() => failures.length === 1, "the thread to be told it failed");
  await looper.settled();
  assert.equal(mains.length, 2);
  // The message names the new work, with its title: the thread's next message has it started.
  await looper.send("a", "And tomorrow?");
  await until(
    () => numbered.some((lines) => lines[0] === "[1] What is the weather?"),
    "the new work to read it",
  );
  assert.equal(mains.length, 2);
  await looper.stop();
});

test("a message both of its works leave before taking is handed back by their leaving, and put to the main loop", async () => {
  const stored = gate();
  let holding = false;
  let backs = 0;
  const { looper, said, asked, mains, numbered, answer } = looperWith({
    writing: (key) => {
      if (!holding || !key.startsWith("thread/t/msg/")) return undefined;
      holding = false;
      return stored.shut;
    },
    routing: (text) => {
      if (text.startsWith(BACK)) return ++backs === 1 ? routeTo("y") : says("Nobody does that.");
      if (text === "Write the report.") return newWork("The report");
      if (text === "Draw the map.") return newWork("The map");
      if (text === "Look at this.") return routeTo("x");
      return newWork("Other");
    },
  });
  await looper.send("x", "Write the report.");
  await until(() => asked.length === 1, "the report's request");
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  await looper.send("y", "Draw the map.");
  await until(() => asked.length === 2, "the map's request");
  answer("Draw the map.", sends("Map done."));
  await looper.settled();
  // A third thread comes to be followed by both, each in a turn there: the report, given what
  // was said there, hands back one said as it works, and the map is given that one.
  await looper.send("t", "Look at this.");
  await until(() => asked.length === 3, "the report to read it");
  await looper.send("t", "And the map legend?");
  answer("Look at this.", []);
  await until(() => asked.length === 4, "the report to read both");
  answer("And the map legend?", handsBack(numberIn(numbered, "report")));
  await until(() => asked.length === 6, "the report's turn to go on, and the map to read it");
  // Said while both are in a turn: each reads it at its next request.
  await looper.send("t", "Unrelated: taxes?");
  answer("And the map legend?", sends("Looked."), "report");
  answer("And the map legend?", sends("Legend done."), "Draw the map");
  await until(() => asked.length === 8, "both to read it");
  const [report, map] = [numberIn(numbered, "report"), numberIn(numbered, "Draw the map")];
  // The next message is still being stored when both hand the first back and leave.
  holding = true;
  const sending = looper.send("t", "Second unrelated.");
  await idle();
  answer("Unrelated: taxes?", handsBack(report, "Not the report.", true), "report");
  answer("Unrelated: taxes?", handsBack(map, "Not the map.", true), "Draw the map");
  await idle();
  stored.open();
  await sending;
  await until(
    () => mains.some(({ input }) => input.at(-2) === "Second unrelated."),
    "the main loop to be given the second",
  );
  // Each turn, which answered a message of its own, goes on once, and ends calling nothing.
  await until(() => asked.length === 10, "both turns to go on");
  answer("Unrelated: taxes?", [], "report");
  answer("Unrelated: taxes?", [], "Draw the map");
  await looper.settled();
  // Neither took it; each handed it back by leaving, and the main loop is told so.
  const put = mains.find(({ input }) => input.at(-2) === "Second unrelated.")?.input.at(-1);
  assert.match(String(put), /The report; because: It left that conversation\./);
  assert.match(String(put), /The map; because: It left that conversation\./);
  assert.equal(said.at(-1), "t: assistant: Nobody does that.");
  assert.equal(
    numbered.some((lines) => lines.some((line) => line.endsWith("Second unrelated."))),
    false,
  );
});

test("a message that came back as the looper closed is decided once by the next", async () => {
  const first = await reported((text) =>
    text.startsWith(BACK) ? new Promise(() => {}) : undefined,
  );
  await first.looper.send("a", "What is the weather?");
  await until(() => first.asked.length === 2, "the request");
  // The looper closes as the worker hands it back: the main loop's decision is cut off.
  const closing = (async () => {
    first.answer("What is the weather?", handsBack(3));
    await until(() => first.values.get("unrouted/a") === true, "it to be the main loop's");
    await first.looper.close();
  })();
  await closing;

  const second = looperWith({
    values: first.values,
    routing: (text) => (text.startsWith(BACK) ? says("I can't tell.") : newWork()),
  });
  await second.looper.resume();
  await until(() => second.said.at(-1) === "a: assistant: I can't tell.", "the answer");
  await second.looper.settled();
  assert.equal(second.mains.length, 1);
  assert.equal(second.values.has("unrouted/a"), false);
  const third = looperWith({ values: first.values });
  await third.looper.resume();
  await idle();
  assert.deepEqual(third.mains, []);
});

test("a thread stays marked while a piece of work in a turn is still taking a message said there", async () => {
  let armed = false;
  let key: string | undefined;
  let writes = 0;
  const report = gate();
  const weather = gate();
  const made = await inTurns({
    // The message's second write is the report taking it, and its third the weather.
    writing: (at) => {
      if (!armed || !at.startsWith("thread/a/msg/")) return undefined;
      key ??= at;
      if (at !== key) return undefined;
      writes++;
      return writes === 2 ? report.shut : writes === 3 ? weather.shut : undefined;
    },
  });
  const { looper, values, asked, numbered, answer } = made;
  await looper.send("a", "How warm is it?");
  goOn(made);
  await until(() => asked.length === 6, "both to read it");
  await idle();
  armed = true;
  const sending = looper.send("a", "And tomorrow?");
  await until(() => writes === 2, "the report to be taking it");
  // The weather's turn keeps what came of a call meanwhile, and takes the message as it does:
  // in memory at once, and stored after the report's taking.
  answer("How warm is it?", handsBack(numberIn(numbered, "weather")), "weather");
  await idle();
  report.open();
  await until(() => writes === 3, "the weather's taking to be written");
  await idle();
  assert.equal(values.get("unrouted/a"), true, "what the store holds still waits for the weather");
  weather.open();
  await sending;
  await until(() => asked.length === 7, "the weather to read it");
  answer("How warm is it?", sends("Not the report's."), "report");
  await until(() => asked.length === 8, "the report to read it");
  assert.equal(values.has("unrouted/a"), false);
  await looper.stop();
});

test("a message that comes back while a decision on its thread is out is decided on though that decision fails", async () => {
  const failing = gate();
  let decisions = 0;
  const made = await inTurns({
    routing: (text) =>
      !text.startsWith(BACK) || !text.includes("Not ours.")
        ? undefined
        : ++decisions === 1
          ? failing.shut.then(() => says("Never said."))
          : says("Nobody here does that."),
  });
  const { looper, values, said, asked, mains, numbered, failures, answer } = made;
  const back = (text: string) => {
    answer(text, handsBack(numberIn(numbered, "report"), "Not ours."), "report");
    answer(text, handsBack(numberIn(numbered, "weather"), "Not ours."), "weather");
  };
  /** Have both turns, which answered messages of their own, end once they go on. */
  const end = async (text: string, count: number) => {
    await until(() => asked.length === count, "both turns to go on");
    answer(text, [], "report");
    answer(text, [], "weather");
  };
  await looper.send("a", "Book a table.");
  goOn(made);
  await until(() => asked.length === 6, "both to read it");
  back("Book a table.");
  // Heard of as it joined their turns, then given to decide.
  await until(() => mains.length === 5, "the main loop to be given it");
  await idle();
  // While that decision is out, another comes back from both, still in their turns.
  await until(() => asked.length === 8, "both turns to go on");
  await looper.send("a", "Book a taxi.");
  await end("Book a table.", 8);
  await until(() => asked.length === 10, "both to read the next");
  back("Book a taxi.");
  await idle();
  assert.equal(mains.length, 5);
  failing.fail();
  // The main loop hears of the next once the decision has failed, and is given both.
  await until(() => mains.length === 7, "the main loop to be given both");
  assert.equal(mains[5]?.instructions, HEARD_INSTRUCTIONS);
  await end("Book a taxi.", 12);
  await looper.settled();
  assert.deepEqual(failures, ["a: failed"]);
  assert.equal(said.at(-1), "a: assistant: Nobody here does that.");
  assert.equal(values.has("unrouted/a"), false);
  await looper.stop();
});

test("work that leaves a thread as the main loop gives it another follows that one, and its thread takes messages after", async () => {
  let armed = false;
  const hold = gate();
  const { looper, values, asked, numbered, failures, answer } = looperWith({
    routing: (text) =>
      text.startsWith(BACK) || text.includes("for the report")
        ? routeTo("a")
        : newWork(text.includes("report") ? "The report" : "The trip"),
    writing: (key) => {
      if (!armed || !key.startsWith("thread/b/msg/")) return undefined;
      armed = false;
      return hold.shut;
    },
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the report's request");
  answer("Write the report.", sends("Report done."));
  await looper.settled();
  await looper.send("b", "Plan the trip.");
  await until(() => asked.length === 2, "the trip's request");
  // The trip hands back a message said as it works, and it is given to the report, which then
  // follows `b` too: both are in a turn there.
  await looper.send("b", "And the figures?");
  answer("Plan the trip.", []);
  await until(() => asked.length === 3, "the trip to read it");
  answer("And the figures?", handsBack(2));
  await until(() => asked.length === 5, "the trip's turn to go on, and the report to read it");
  // Said while both are in a turn: each reads it at its next request.
  await looper.send("b", "Which hotel?");
  answer("And the figures?", sends("Trip planned."), "trip");
  answer("And the figures?", sends("Figures added."), "report");
  await until(() => asked.length === 7, "both to read it");
  const number = numberIn(numbered, "report");
  // The next message there is still being written when the report leaves: what waits for it
  // there is handed back after that write.
  armed = true;
  const next = looper.send("b", "And the flight?");
  await idle();
  answer("Which hotel?", handsBack(number, "Not the report's.", true), "report");
  await idle();
  // Meanwhile the main loop gives the report a third thread.
  const given = looper.send("c", "This is for the report.");
  await idle();
  hold.open();
  await next;
  await given;
  await until(() => asked.length >= 8, "the report to read what it was given");
  const report = works(values).find(({ id }) => id === "a") as {
    follows: string[];
    left?: string[];
  };
  assert.deepEqual(report.follows, ["a", "b", "c"]);
  assert.deepEqual(report.left, ["b"]);
  await looper.send("c", "Again for the report.");
  assert.deepEqual(failures, []);
  await looper.stop();
});

test("a looper that closes as work with nothing to take is starting leaves the next nothing to go on with in that work", async () => {
  let refusing = false;
  let writes = 0;
  const first = await inTurns({
    // The message's third write is the weather taking it.
    writing: (key) =>
      refusing && key.startsWith("thread/a/msg/") && ++writes === 3
        ? Promise.reject(new Error("the store refused it"))
        : undefined,
  });
  refusing = true;
  await first.looper.send("a", "Thanks, both.");
  // The report reads it at its next request, answers, and is at rest; the weather, which
  // couldn't take it, is still at what it was when the looper closes.
  first.answer("What is the weather?", sends("Report done."), "report");
  await until(() => first.asked.length === 5, "the report to read it");
  first.answer("Thanks, both.", sends("Welcome."));
  await until(() => first.values.has("unfinished/a") === false, "the report to be at rest");
  await idle();
  refusing = false;
  await first.looper.close();

  // The next looper gives the message to both again: the report has it, and has nothing to take.
  const hold = gate();
  let marking = false;
  const second = looperWith({
    values: new Map(first.values),
    writing: (key) => {
      if (key !== "unfinished/a" || marking) return undefined;
      marking = true;
      return hold.shut;
    },
  });
  void second.looper.resume();
  await until(() => marking, "the report's mark to be written");
  await second.looper.close();
  hold.open();
  await idle();

  const third = looperWith({ values: new Map(second.values) });
  await third.looper.resume();
  await idle();
  // The weather goes on if it had taken the message by then: the report, whose last turn had
  // ended, is asked nothing either way.
  assert.deepEqual(
    third.told.filter(({ instructions }) => instructions.includes("The report")),
    [],
  );
  await third.looper.stop();
});

test("work stopped while a message is still being given to the thread's other work is not started again by the next looper", async () => {
  const hold = gate();
  let armed = false;
  let writes = 0;
  const first = await inTurns({
    // The message's third write: the weather, in a turn, taking it after the report.
    writing: (key) =>
      armed && key === "thread/a/msg/000000000004" && ++writes === 3 ? hold.shut : undefined,
  });
  armed = true;
  const sending = first.looper.send("a", "Thanks, both.");
  await until(() => writes === 3, "the report to have taken it, the weather taking it");
  // The report's turn is stopped, and the looper closes before the weather has the message.
  await first.looper.cancel("a");
  await idle();
  const closing = first.looper.close();
  await idle();
  hold.open();
  await Promise.all([closing, sending]);
  await idle();

  const second = looperWith({ values: new Map(first.values) });
  await second.looper.resume();
  await until(() => second.asked.length === 1, "the weather to go on");
  await idle();
  assert.deepEqual(
    second.told.map(({ instructions }) => instructions.includes("The weather")),
    [true],
    "the report, whose turn was stopped, is asked nothing",
  );
  await second.looper.stop();
});

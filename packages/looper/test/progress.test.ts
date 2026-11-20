import assert from "node:assert/strict";
import test from "node:test";
import { Entry, textOf } from "../src/index.ts";
import {
  gate,
  handsBack,
  idle,
  looperWith,
  newWork,
  says,
  sends,
  stops,
  until,
} from "./support.ts";

const BACK = "That was given to this work, which handed it back:";

/** Each fact said, as `thread: text fact`: the message named by its text, as the store keeps it. */
const facts = (made: ReturnType<typeof looperWith>) =>
  made.progress.map((line) => {
    const [, thread = "", id = "", fact = ""] = /^(.*): (\S+) (\S+)$/.exec(line) ?? [];
    const kept = made.values.get(`thread/${encodeURIComponent(thread)}/msg/${id}`);
    return `${thread}: ${kept === undefined ? id : textOf(Entry.parse(kept))} ${fact}`;
  });
/** The facts said of the message `text`. */
const of = (made: ReturnType<typeof looperWith>, text: string) =>
  facts(made).filter((fact) => fact.includes(`: ${text} `));

/** The number the newest message of a request starts with: the request of the work that began with `first`. */
const numberIn = (numbered: string[][], first: string) => {
  const request = numbered.findLast((lines) => lines[0]?.includes(first));
  const newest = request?.findLast((line) => /^\[\d+\] /.test(line)) ?? "";
  return Number(/^\[(\d+)\]/.exec(newest)?.[1]);
};

test("a message a worker's request reads for the first time is taken", async () => {
  const made = looperWith();
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", sends("Done."));
  await made.looper.settled();
  const decided = made.routed.length;
  // Given to the work by code: no main loop reads it, its worker's request does.
  await made.looper.send("a", "Again.");
  await until(() => made.asked.length === 2, "the request that reads it");
  await idle();
  assert.equal(made.routed.length, decided);
  assert.deepEqual(of(made, "Again."), ["a: Again. taken"]);
  made.answer("Again.", sends("Done again."));
  await made.looper.settled();
  assert.deepEqual(of(made, "Again."), ["a: Again. taken", "a: Again. answered"]);
});

test("a message the main loop decides on is taken as its request is made, and its worker takes it no further", async () => {
  const deciding = gate();
  const made = looperWith({ routing: () => deciding.shut.then(() => newWork()) });
  await made.looper.send("a", "Write the report.");
  await until(() => made.routed.length === 1, "the main loop's request");
  assert.deepEqual(facts(made), ["a: Write the report. taken"]);
  deciding.open();
  await until(() => made.asked.length === 1, "the work's request");
  await idle();
  assert.deepEqual(facts(made), ["a: Write the report. taken"]);
  await made.looper.stop();
});

test("a message a worker sends a reply to is answered", async () => {
  const made = looperWith();
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", sends("Done."));
  await made.looper.settled();
  assert.deepEqual(facts(made), ["a: Write the report. taken", "a: Write the report. answered"]);
});

test("what the main loop answers itself, or stops work for, is answered; a receipt beside new work answers nothing", async () => {
  const made = looperWith({
    routing: (text) =>
      text === "Hello."
        ? says("Hi there.")
        : text === "Stop the report."
          ? stops("b")
          : [...says("On it."), ...newWork("The report")],
  });
  await made.looper.send("a", "Hello.");
  await until(() => made.said.length === 2, "the main loop's answer");
  await made.looper.settled();
  assert.deepEqual(of(made, "Hello."), ["a: Hello. taken", "a: Hello. answered"]);
  await made.looper.send("b", "Write the report.");
  await until(() => made.asked.length === 1, "the work's request");
  await idle();
  assert.equal(made.said.includes("b: assistant: On it."), true);
  assert.deepEqual(of(made, "Write the report."), ["b: Write the report. taken"]);
  await made.looper.send("c", "Stop the report.");
  await until(() => made.said.includes("c: assistant: Stopped."), "the stop's answer");
  await made.looper.settled();
  assert.deepEqual(of(made, "Stop the report."), [
    "c: Stop the report. taken",
    "c: Stop the report. answered",
  ]);
  // The work it stopped closes its message: the stop answers only its own.
  assert.deepEqual(of(made, "Write the report."), [
    "b: Write the report. taken",
    "b: Write the report. closed",
  ]);
});

/** Whether the message `text` in `thread` is kept as having gone unanswered. */
const unanswered = (made: ReturnType<typeof looperWith>, thread: string, text: string) =>
  [...made.values]
    .filter(([key]) => key.startsWith(`thread/${encodeURIComponent(thread)}/msg/`))
    .map(([, value]) => Entry.parse(value))
    .some((entry) => textOf(entry) === text && entry.unanswered === true);

test("what the main loop answered, or stopped work for, stays answered when new work takes its thread", async () => {
  const made = looperWith({
    routing: (text) =>
      text === "Hello."
        ? says("Hi there.")
        : text === "Stop the report."
          ? stops("b")
          : [...says("On it."), ...newWork()],
  });
  await made.looper.send("b", "Write the report.");
  await until(() => made.asked.length === 1, "the report's request");
  await made.looper.send("a", "Hello.");
  await until(() => made.said.includes("a: assistant: Hi there."), "the main loop's answer");
  await made.looper.send("a", "Stop the report.");
  await until(() => made.said.includes("a: assistant: Stopped."), "the stop's answer");
  await made.looper.settled();
  // The thread becomes new work's own, with all that was said there.
  await made.looper.send("a", "Write the summary.");
  await until(() => made.asked.length === 2, "the summary's request");
  assert.deepEqual(made.inputs[1], [
    "Hello.",
    "Hi there.",
    "Stop the report.",
    "Stopped.",
    "Write the summary.",
    "On it.",
  ]);
  made.answer("Write the summary.", sends("Summary done."));
  await made.looper.settled();
  // Its turn answered its own message: nothing it holds went unanswered.
  assert.deepEqual(made.failures, []);
  assert.deepEqual(of(made, "Hello."), ["a: Hello. taken", "a: Hello. answered"]);
  assert.deepEqual(of(made, "Stop the report."), [
    "a: Stop the report. taken",
    "a: Stop the report. answered",
  ]);
  assert.deepEqual(of(made, "Write the summary."), [
    "a: Write the summary. taken",
    "a: Write the summary. answered",
  ]);
  for (const text of ["Hello.", "Stop the report.", "Write the summary."])
    assert.equal(unanswered(made, "a", text), false, text);
});

test("a receipt beside new work answers nothing: in a thread the main loop answered, the work's turn leaves only its own message unanswered", async () => {
  const made = looperWith({
    routing: (text) =>
      text === "Hello." ? says("Hi there.") : [...says("On it."), ...newWork("The report")],
  });
  await made.looper.send("a", "Hello.");
  await until(() => made.said.includes("a: assistant: Hi there."), "the main loop's answer");
  await made.looper.settled();
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the work's request");
  made.answer("Write the report.", says("Thinking about it."));
  await made.looper.settled();
  assert.deepEqual(made.failures, ["a: not_answered"]);
  assert.deepEqual(facts(made), [
    "a: Hello. taken",
    "a: Hello. answered",
    "a: Write the report. taken",
    "a: Write the report. closed",
  ]);
  assert.equal(unanswered(made, "a", "Hello."), false);
  assert.equal(unanswered(made, "a", "Write the report."), true);
});

test("a message its turn ends without answering is closed, as it is said to have gone unanswered", async () => {
  const made = looperWith();
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", says("Thinking about it."));
  await made.looper.settled();
  assert.deepEqual(made.failures, ["a: not_answered"]);
  assert.deepEqual(facts(made), ["a: Write the report. taken", "a: Write the report. closed"]);
});

test("a message a failed turn read and left open is closed", async () => {
  const made = looperWith();
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.fail("Write the report.", new Error("the model refused it"));
  await made.looper.settled();
  assert.deepEqual(made.failures, ["a: failed"]);
  assert.deepEqual(facts(made), ["a: Write the report. taken", "a: Write the report. closed"]);
  // A failure tells the thread, not the message: it is not said to have gone unanswered.
  assert.equal("unanswered" in (made.values.get("thread/a/msg/000000000001") as object), false);
});

test("a message a stopped turn read and left open is closed", async () => {
  const made = looperWith();
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  await made.looper.cancel("a");
  await made.looper.settled();
  assert.deepEqual(facts(made), ["a: Write the report. taken", "a: Write the report. closed"]);
  assert.equal("unanswered" in (made.values.get("thread/a/msg/000000000001") as object), false);
});

test("a message a stopped turn's request held is closed once the stop is done, though its model never hears the stop", async () => {
  const made = looperWith({ deaf: true });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  await made.looper.cancel("a");
  await until(() => made.progress.length === 2, "the close");
  assert.deepEqual(facts(made), ["a: Write the report. taken", "a: Write the report. closed"]);
  made.fail("Write the report.");
  await made.looper.settled();
  assert.deepEqual(facts(made), ["a: Write the report. taken", "a: Write the report. closed"]);
});

test("a message a restart cut off, in a looper stopped before it goes on, is closed", async () => {
  const first = looperWith();
  await first.fill(["a"]);
  // Closed under, it is not stopped: the next looper may go on with it.
  await first.looper.close();
  await first.looper.settled();
  assert.deepEqual(facts(first), ["a: Work a. taken"]);
  const second = looperWith({ values: first.values });
  await second.looper.stop();
  assert.deepEqual(facts(second), ["a: Work a. closed"]);
  assert.deepEqual(
    [...second.values.keys()].filter((key) => key.startsWith("unfinished/")),
    [],
  );
});

test("a message waiting to be decided as the looper stops is closed, and answered when it is decided after", async () => {
  const never = gate();
  let decisions = 0;
  const made = looperWith({
    routing: () => (++decisions === 1 ? never.shut.then(() => newWork()) : says("Noted, both.")),
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.routed.length === 1, "the main loop's request");
  await made.looper.stop();
  assert.deepEqual(facts(made), ["a: Write the report. taken", "a: Write the report. closed"]);
  made.looper.start();
  await made.looper.send("a", "Still there?");
  await until(() => made.said.includes("a: assistant: Noted, both."), "the main loop's answer");
  await made.looper.settled();
  assert.deepEqual(facts(made), [
    "a: Write the report. taken",
    "a: Write the report. closed",
    "a: Still there? taken",
    "a: Write the report. answered",
    "a: Still there? answered",
  ]);
});

test("a message given to several pieces of work is taken once and answered once, though each replies", async () => {
  const made = looperWith({
    routing: (text) => (text.startsWith(BACK) ? newWork("The weather") : newWork("The report")),
  });
  // Thread `a` followed by two pieces of work, each in a turn with its request out.
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the report's request");
  await made.looper.send("a", "What is the weather?");
  await until(() => made.mains.length === 2, "the main loop to hear of it");
  made.answer("Write the report.", []);
  await until(() => made.asked.length === 2, "the report's request that reads both");
  made.answer("What is the weather?", handsBack(numberIn(made.numbered, "report")));
  await until(() => made.asked.length === 4, "the report's turn to go on, and the weather's");
  await made.looper.send("a", "Thanks, both.");
  made.answer("What is the weather?", sends("Report done."), "report");
  made.answer("What is the weather?", sends("Sunny."), "weather");
  await until(() => made.asked.length === 6, "both to read it");
  made.answer("Thanks, both.", sends("You're welcome."), "report");
  made.answer("Thanks, both.", sends("Any time."), "weather");
  await made.looper.settled();
  assert.equal(made.said.includes("a: assistant: You're welcome."), true);
  assert.equal(made.said.includes("a: assistant: Any time."), true);
  assert.deepEqual(of(made, "Thanks, both."), [
    "a: Thanks, both. taken",
    "a: Thanks, both. answered",
  ]);
});

test("a message handed back by all its work goes back to the main loop: it stays taken, is not closed, and is answered", async () => {
  const made = looperWith({
    routing: (text) => (text.startsWith(BACK) ? newWork("The weather") : newWork("The report")),
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the report's request");
  made.answer("Write the report.", sends("Report done."));
  await made.looper.settled();
  await made.looper.send("a", "What is the weather?");
  await until(() => made.asked.length === 2, "the report's worker to read it");
  made.answer("What is the weather?", handsBack(3, "It asks about the weather."));
  await until(() => made.mains.length === 2, "the main loop to be given it");
  await until(() => made.asked.length === 3, "the new work's request");
  await idle();
  assert.deepEqual(of(made, "What is the weather?"), ["a: What is the weather? taken"]);
  made.answer("What is the weather?", sends("Sunny."));
  await made.looper.settled();
  assert.deepEqual(of(made, "What is the weather?"), [
    "a: What is the weather? taken",
    "a: What is the weather? answered",
  ]);
});

test("a message whose turn fails before any request reads it is closed with nothing said before", async () => {
  let refusing = false;
  const made = looperWith({
    instructions: () => {
      if (refusing) throw new Error("the host refused it");
      return "";
    },
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", sends("Done."));
  await made.looper.settled();
  refusing = true;
  await made.looper.send("a", "Again.");
  await until(() => made.failures.length === 1, "the turn to fail");
  await made.looper.settled();
  assert.equal(made.asked.length, 1);
  assert.deepEqual(of(made, "Again."), ["a: Again. closed"]);
});

test("what became of a message the store won't keep is not said, and its work goes on as before", async () => {
  let writes = 0;
  const made = looperWith({
    // The message's second write is the main loop's "taken": refused.
    writing: (key) =>
      key === "thread/a/msg/000000000001" && ++writes === 2
        ? Promise.reject(new Error("no"))
        : undefined,
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the work's request");
  made.answer("Write the report.", sends("Done."));
  await made.looper.settled();
  assert.deepEqual(made.failures, []);
  assert.equal(made.said.includes("a: assistant: Done."), true);
  // Not said as the main loop took it; said as its work's request did, which was kept.
  assert.deepEqual(facts(made), ["a: Write the report. taken", "a: Write the report. answered"]);
});

test("what became of each message is kept on it: a page read after, by this looper or the next, carries it", async () => {
  const made = looperWith({
    routing: (text) => (text === "Hello." ? says("Hi there.") : newWork()),
  });
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", sends("Done."));
  await made.looper.settled();
  await made.looper.send("a", "Shorter.");
  await until(() => made.asked.length === 2, "the request");
  made.answer("Shorter.", says("Thinking about it."));
  await made.looper.send("b", "Hello.");
  await until(() => made.said.includes("b: assistant: Hi there."), "the main loop's answer");
  await made.looper.settled();
  const page = async (looper: typeof made.looper, thread: string) =>
    (await looper.page(thread, undefined, 50)).messages.map(({ text, progress }) =>
      progress === undefined ? text : `${text} (${progress.state})`,
    );
  const again = looperWith({ values: made.values });
  for (const looper of [made.looper, again.looper]) {
    assert.deepEqual(await page(looper, "a"), [
      "Write the report. (answered)",
      "Done.",
      "Shorter. (closed)",
    ]);
    assert.deepEqual(await page(looper, "b"), ["Hello. (answered)", "Hi there."]);
  }
});

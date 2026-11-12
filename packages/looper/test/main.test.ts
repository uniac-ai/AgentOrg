import assert from "node:assert/strict";
import test from "node:test";
import type { Json } from "../src/index.ts";
import { MAIN_INSTRUCTIONS } from "../src/main.ts";
import { gate, idle, looperWith, newWork, routeTo, says, sends, until } from "./support.ts";

const texts = async (looper: ReturnType<typeof looperWith>["looper"], thread: string) =>
  (await looper.page(thread, undefined, 50)).messages.map((message) => message.text);

test("a plain message is answered by the main loop itself: its text is the thread's reply, and no work starts", async () => {
  const { looper, values, said, asked, working } = looperWith({
    routing: () => says("Hello. What can I do?"),
  });
  await looper.send("a", "Hi.");
  await until(() => said.length === 2, "the answer");
  assert.deepEqual(said, ["a: user: Hi.", "a: assistant: Hello. What can I do?"]);
  await looper.settled();
  assert.deepEqual(asked, []);
  assert.deepEqual(working, [true, false]);
  // Nothing follows the thread: it has no work, and its next message asks the main loop again.
  assert.equal(values.has("work/a"), false);
  assert.equal(values.get("unrouted/a"), false);
  assert.equal(values.has("unfinished/a"), false);
  assert.deepEqual(await texts(looper, "a"), ["Hi.", "Hello. What can I do?"]);
});

test("the main loop is told to answer only what needs no work, and never to promise any", () => {
  assert.match(MAIN_INSTRUCTIONS, /only when it needs no tools and nothing you can't see here/);
  assert.match(MAIN_INSTRUCTIONS, /Never say you will do, find, check or look into something/);
  assert.match(MAIN_INSTRUCTIONS, /when in doubt whose it is, it is new work/);
});

test("it speaks as whoever hosts it says, after its own words", async () => {
  const { looper, mains, said } = looperWith({
    voice: "You are Scout. What you are for: scouting ahead.",
    routing: () => says("I am Scout."),
  });
  await looper.send("a", "Who are you?");
  await until(() => said.length === 2, "the answer");
  assert.equal(
    mains[0]?.instructions,
    `${MAIN_INSTRUCTIONS}\n\nWhen you answer yourself, you speak as the one described below. What that one is told to do is a worker's to do, not yours:\n\nYou are Scout. What you are for: scouting ahead.`,
  );
});

test("its text is streamed to the reply it becomes", async () => {
  const answering = gate();
  const { looper, mainIds, messages, deltas } = looperWith({
    routing: () => answering.shut.then(() => says("Hello there.")),
  });
  await looper.send("a", "Hi.");
  await until(() => mainIds.length === 1, "the main loop to be asked");
  looper.delta(mainIds[0] as string, "Hello");
  looper.delta("a request nobody made", "lost");
  answering.open();
  await until(() => messages.length === 2, "the answer");
  assert.deepEqual(deltas, [{ thread: "a", id: messages[1]?.id, text: "Hello" }]);
});

test("the thread's next message is put to it with what was said there, its own answers too", async () => {
  const { looper, mains, said } = looperWith({
    routing: (text) => says(text === "Hi." ? "Hello." : "Scout."),
  });
  await looper.send("a", "Hi.");
  await until(() => said.length === 2, "the first answer");
  await looper.send("a", "And who are you?");
  await until(() => said.length === 4, "the second answer");
  assert.deepEqual(mains[1]?.input, ["There is no work.", "Hi.", "Hello.", "And who are you?"]);
  await looper.settled();
});

test("a message that becomes work takes the thread with what was said in it, as new work", async () => {
  const { looper, values, said, asked, inputs, answer, fill } = looperWith({
    routing: (text) => (text === "Hi." ? says("Hello.") : newWork("The report")),
  });
  // Four turns hold the places, and the line for one is not full.
  await fill(["w", "x", "y", "z"]);
  await looper.send("a", "Hi.");
  await until(() => said.includes("a: assistant: Hello."), "the answer");
  await looper.send("a", "Write the report.");
  await idle();
  // The main loop's answer is not the work's doing: it waits its turn as new work does.
  assert.equal(asked.includes("Write the report."), false);
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  answer("Work w.");
  await until(() => asked.includes("Write the report."), "its turn");
  assert.deepEqual(inputs.at(-1), ["Hi.", "Hello.", "Write the report."]);
  assert.deepEqual(values.get("work/a"), { title: "The report", follows: ["a"] });
  assert.equal(values.has("unrouted/a"), false);
  await looper.stop();
});

test("text beside a call is kept as its answer, and the message is placed all the same", async () => {
  const { looper, said, asked, inputs } = looperWith({
    routing: () => [...says("On it."), ...newWork("The report")],
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's turn");
  assert.deepEqual(said, ["a: user: Write the report.", "a: assistant: On it."]);
  assert.deepEqual(inputs[0], ["Write the report.", "On it."]);
  await looper.stop();
});

test("a message said while the main loop answers is answered next, after the answer that hadn't read it", async () => {
  const answering = gate();
  const { looper, mains, said, asked, inputs } = looperWith({
    routing: (text) =>
      text === "Hi."
        ? answering.shut.then(() => says("Hello."))
        : text === "Anyone?"
          ? says("Yes.")
          : newWork(),
  });
  await looper.send("a", "Hi.");
  await until(() => mains.length === 1, "the main loop to be asked");
  await looper.send("a", "Anyone?");
  answering.open();
  await until(() => said.length === 4, "both answers");
  assert.deepEqual(said, [
    "a: user: Hi.",
    "a: user: Anyone?",
    "a: assistant: Hello.",
    "a: assistant: Yes.",
  ]);
  // It read them in the order they were answered, and so does the work that takes the thread.
  assert.deepEqual(mains[1]?.input.slice(1), ["Hi.", "Hello.", "Anyone?"]);
  await looper.send("a", "Write it up.");
  await until(() => asked.length === 1, "the work's turn");
  assert.deepEqual(inputs[0], ["Hi.", "Hello.", "Anyone?", "Yes.", "Write it up."]);
  await looper.stop();
});

test("an answered thread leaves nothing to go on with: the next looper asks nobody", async () => {
  const first = looperWith({ routing: () => says("Hello.") });
  await first.looper.send("a", "Hi.");
  await until(() => first.said.length === 2, "the answer");
  await first.looper.close();
  await first.looper.settled();

  const second = looperWith({ values: first.values, routing: () => says("Still here.") });
  await second.looper.resume();
  await idle();
  assert.deepEqual(second.routed, []);
  assert.deepEqual(second.asked, []);
  // Its next message is the main loop's still, with what was said before.
  await second.looper.send("a", "Still there?");
  await until(() => second.said.length === 2, "the answer");
  assert.deepEqual(second.mains[0]?.input, ["There is no work.", "Hi.", "Hello.", "Still there?"]);
});

test("an answer cut off by the looper going is asked for again by the next, once", async () => {
  const never = gate();
  const first = looperWith({ routing: () => never.shut.then(() => says("Hello.")) });
  await first.looper.send("a", "Hi.");
  await until(() => first.routed.length === 1, "the main loop to be asked");
  await first.looper.close();
  await first.looper.settled();

  const second = looperWith({ values: first.values, routing: () => says("Hello again.") });
  await second.looper.resume();
  await until(() => second.said.length === 1, "the answer");
  assert.deepEqual(second.said, ["a: assistant: Hello again."]);
  assert.equal(second.values.get("unrouted/a"), false);
});

test("work at rest is told of with what it last said, and a message that points at it goes on with it", async () => {
  const { looper, values, asked, mains, inputs, answer } = looperWith({
    routing: (text) => (text.includes("chart") ? routeTo("a") : newWork("The report")),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's turn");
  answer("Write the report.", sends("Report  done.\nIt has four parts."));
  await looper.settled();
  await looper.send("c", "Add a chart to the report.");
  await until(() => asked.length === 2, "the work to go on");
  assert.equal(
    mains[1]?.input[0],
    "The work there is:\n- a: The report (at rest); it last said: Report done. It has four parts.",
  );
  assert.deepEqual(inputs[1], [
    "Write the report.",
    "Report  done.\nIt has four parts.",
    "Add a chart to the report.",
  ]);
  assert.deepEqual((values.get("work/a") as { follows: string[] }).follows, ["a", "c"]);
  await looper.stop();
});

test("the main loop is told of twelve pieces of work at most: those in a turn, then the latest at rest", async (t) => {
  // Each turn ends at a time of its own.
  t.mock.timers.enable({ apis: ["Date"] });
  const { looper, asked, mains, answer } = looperWith({
    routing: (text) => newWork(text.replace("Work ", "Title ").replace(".", "")),
  });
  for (let i = 0; i < 13; i++) {
    await looper.send(`t${i}`, `Work ${i}.`);
    await until(() => asked.length === i + 1, "its turn");
    answer(`Work ${i}.`, sends(`Done ${i}.`));
    await looper.settled();
    t.mock.timers.tick(1000);
  }
  await looper.send("busy", "Work busy.");
  await until(() => asked.length === 14, "its turn");
  await looper.send("new", "Work new.");
  await until(() => mains.length === 15, "the main loop to be asked");
  const lines = String(mains[14]?.input[0]).split("\n").slice(1);
  assert.equal(lines.length, 12);
  assert.equal(lines[0], "- busy: Title busy (in a turn)");
  assert.equal(lines[1], "- t12: Title 12 (at rest); it last said: Done 12.");
  assert.equal(lines[11], "- t2: Title 2 (at rest); it last said: Done 2.");
  await looper.stop();
});

test("a thread kept before works had records gets one when its turn ends, and is told of like any work", async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const values = new Map<string, Json>([
    [
      "thread/old/msg/000000000001",
      {
        id: "1",
        role: "user",
        at,
        items: [{ type: "message", role: "user", content: "Earlier." }],
      },
    ],
  ]);
  const { looper, asked, mains, said, answer } = looperWith({
    values,
    routing: () => says("One thing."),
  });
  await looper.send("old", "And now?");
  await until(() => asked.length === 1, "its turn");
  answer("And now?", sends("Now this."));
  await looper.settled();
  await looper.send("b", "What is there?");
  await until(() => said.includes("b: assistant: One thing."), "the answer");
  assert.equal(
    mains[0]?.input[0],
    "The work there is:\n- old: Earlier. (at rest); it last said: Now this.",
  );
});

test("work whose last turn failed is told of as that", async () => {
  const { looper, asked, mains, said, fail } = looperWith({
    routing: (text) => (text === "Try this." ? newWork("A try") : says("One thing.")),
  });
  await looper.send("a", "Try this.");
  await until(() => asked.length === 1, "its turn");
  fail("Try this.");
  await looper.settled();
  await looper.send("b", "What is there?");
  await until(() => said.includes("b: assistant: One thing."), "the answer");
  assert.equal(
    mains[1]?.input[0],
    "The work there is:\n- a: A try (at rest; its last turn failed)",
  );
});

test("a looper made again on the same store tells of the work there was, with what it last said", async () => {
  const first = looperWith({ routing: () => newWork("The report") });
  await first.looper.send("a", "Write the report.");
  await until(() => first.asked.length === 1, "its turn");
  first.answer("Write the report.", sends("Report done."));
  await first.looper.settled();

  const second = looperWith({ values: first.values, routing: () => says("The report.") });
  await second.looper.send("b", "What is there?");
  await until(() => second.said.length === 2, "the answer");
  assert.equal(
    second.mains[0]?.input[0],
    "The work there is:\n- a: The report (at rest); it last said: Report done.",
  );
});

test("a thread the main loop answered, then given to work there is, is read by that work in the order it was said", async () => {
  const { looper, values, said, asked, inputs, answer } = looperWith({
    routing: (text) =>
      text === "Write the report."
        ? newWork("The report")
        : text === "Hi."
          ? says("Hello.")
          : // Text beside the call is said too.
            [...says("Passing it on."), ...routeTo("a")],
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's turn");
  await looper.send("c", "Hi.");
  await until(() => said.includes("c: assistant: Hello."), "the answer");
  await looper.send("c", "Add a chart to the report.");
  await until(() => !values.has("unrouted/c"), "the thread to be taken");
  assert.ok(said.includes("c: assistant: Passing it on."));
  answer("Write the report.", sends("Report done."));
  await until(() => asked.length === 2, "the request that reads the thread");
  const read = [
    "Write the report.",
    "Report done.",
    "Hi.",
    "Hello.",
    "Add a chart to the report.",
    "Passing it on.",
  ];
  assert.deepEqual(inputs[1], read);
  answer("Add a chart to the report.", sends("Chart added."));
  await looper.settled();
  // What the main loop said there isn't what the work last said.
  assert.equal((values.get("work/a") as { last: string }).last, "Chart added.");
  assert.equal(said.at(-1), "c: assistant: Chart added.");

  // A looper made again on the same store reads it the same.
  const again = looperWith({ values });
  await again.looper.send("c", "Thanks.");
  await until(() => again.asked.length === 1, "the work's turn");
  assert.deepEqual(again.inputs[0], [...read, "Chart added.", "Thanks."]);
  await again.looper.stop();
});

test("a message said while the main loop answers is still to be decided on when the looper goes, and the next asks", async () => {
  const answering = gate();
  const never = gate();
  const first = looperWith({
    routing: (text) =>
      text === "Hi." ? answering.shut.then(() => says("Hello.")) : never.shut.then(() => says("?")),
  });
  await first.looper.send("a", "Hi.");
  await until(() => first.mains.length === 1, "the main loop to be asked");
  await first.looper.send("a", "Anyone?");
  answering.open();
  await until(() => first.mains.length === 2, "the second message to be asked about");
  await first.looper.close();
  await first.looper.settled();
  assert.equal(first.values.get("unrouted/a"), true);

  const second = looperWith({ values: first.values, routing: () => says("Yes.") });
  await second.looper.resume();
  await until(() => second.said.length === 1, "the answer");
  assert.deepEqual(second.mains[0]?.input.slice(1), ["Hi.", "Hello.", "Anyone?"]);
  assert.deepEqual(second.said, ["a: assistant: Yes."]);
});

test("a stop that lands as an answer beside a call is kept starts nothing; its work is decided all the same", async () => {
  const keeping = gate();
  let kept = 0;
  let reached = false;
  const { looper, values, said, asked, mains, working, inputs } = looperWith({
    routing: () => [...says("On it."), ...newWork("The report")],
    writing(key) {
      // The thread's second message is the main loop's answer.
      if (!key.startsWith("thread/t/msg/") || ++kept !== 2) return undefined;
      reached = true;
      return keeping.shut;
    },
  });
  await looper.send("t", "Write the report.");
  await until(() => reached, "the answer to be on its way to the store");
  const stopping = looper.stop();
  keeping.open();
  await stopping;
  await idle();
  assert.deepEqual(said, ["t: user: Write the report.", "t: assistant: On it."]);
  assert.deepEqual(asked, []);
  assert.equal(working.at(-1), false);
  assert.equal(values.get("unrouted/t"), false);
  // Started again, the thread's next message goes to that work by code, with what was said.
  looper.start();
  await looper.send("t", "Go.");
  await until(() => asked.length === 1, "its work's turn");
  assert.equal(mains.length, 1);
  assert.deepEqual(inputs[0], ["Write the report.", "On it.", "Go."]);
  assert.equal(values.has("unrouted/t"), false);
  await looper.stop();
});

test("a failed decision is not asked again by itself, though a message was kept before it read the thread", async () => {
  let refuse = true;
  const deciding = gate();
  const { looper, values, mains, failures } = looperWith({
    routing: () => deciding.shut.then(() => (refuse ? Promise.reject(new Error("no")) : newWork())),
  });
  // Two threads: the second's decision waits for the first's, and reads both of its messages.
  await looper.send("a", "First of a.");
  await looper.send("b", "First of b.");
  await looper.send("b", "Second of b.");
  deciding.open();
  await until(() => failures.length === 2, "both to be told");
  await idle();
  assert.deepEqual(mains[1]?.input.slice(1), ["First of b.", "Second of b."]);
  assert.equal(mains.length, 2);
  assert.equal(values.get("unrouted/b"), false);
  refuse = false;
  await looper.stop();
});

test("work that can't take a thread's messages is told so once, though one was kept while the main loop decided", async () => {
  const deciding = gate();
  const { looper, values, failures, mains, fill } = looperWith({
    routing: (text) =>
      text.startsWith("Work ") ? newWork() : deciding.shut.then(() => newWork("Late")),
  });
  // Every place is taken, and the line for one is full.
  await fill(["a", "b", "c", "d"]);
  for (let i = 0; i < 16; i++) await looper.send(`w${i}`, `Work w${i}.`);
  await until(() => mains.length === 20, "the line to be full");
  await looper.send("t", "First.");
  await until(() => mains.length === 21, "the main loop to be asked");
  await looper.send("t", "Second.");
  deciding.open();
  await until(() => failures.length === 1, "the thread to be told");
  await idle();
  assert.deepEqual(failures, ["t: busy"]);
  assert.equal(mains.length, 21);
  assert.equal(values.get("unrouted/t"), false);
  await looper.stop();
});

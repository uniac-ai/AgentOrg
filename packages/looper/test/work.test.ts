import assert from "node:assert/strict";
import test from "node:test";
import type { Json } from "../src/index.ts";
import { MAIN_INSTRUCTIONS, put, ROUTE } from "../src/main.ts";
import { gate, idle, looperWith, newWork, routeTo, says, until } from "./support.ts";

const texts = async (looper: ReturnType<typeof looperWith>["looper"], thread: string) =>
  (await looper.page(thread, undefined, 50)).messages.map((message) => message.text);

test("a message in a thread nothing follows is kept at once, and the main loop says it is new work", async () => {
  const { looper, values, said, asked, routed, working, inputs, answer } = looperWith();
  const { messageId } = await looper.send("a", "Write the report.\nAll of it.");
  // Kept and said before the main loop has answered anything.
  assert.deepEqual(said, ["a: user: Write the report.\nAll of it."]);
  assert.ok(messageId);
  await until(() => asked.length === 1, "the work's request");
  // The main loop was put the message, with no work under way to choose from.
  assert.deepEqual(routed, [
    "No work is under way.\n\nWhat came in:\nWrite the report.\nAll of it.",
  ]);
  // The work is the thread's own, with the title it was given, and reads the message as it is.
  assert.deepEqual(values.get("work/a"), { title: "Work", follows: ["a"] });
  assert.deepEqual(inputs[0], ["Write the report.\nAll of it."]);
  // At work from the message on, the main loop's part included, and said once.
  assert.deepEqual(working, [true]);
  // A further message is the work's, by code: the main loop isn't asked again.
  await looper.send("a", "And a summary.");
  answer("Write the report.\nAll of it.", says("Report done."));
  await until(() => asked.length === 2, "the request that reads it");
  answer("And a summary.");
  await looper.settled();
  assert.equal(routed.length, 1);
  assert.deepEqual(working, [true, false]);
  assert.equal(values.has("unrouted/a"), false);
});

test("the main loop's request is its own words, one function, and what came in with the work in a turn", async () => {
  const { looper, asked, mains } = looperWith({
    routing: (text) => (text.includes("chart") ? routeTo("a") : newWork("The report")),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("c", "Add a chart to the report.");
  await until(() => mains.length === 2, "the main loop to be asked");
  assert.deepEqual(mains[1], {
    instructions: MAIN_INSTRUCTIONS,
    tools: [ROUTE],
    // Nothing of what it was put before, or decided.
    input: ["Work under way:\n- a: The report\n\nWhat came in:\nAdd a chart to the report."],
  });
  assert.match(MAIN_INSTRUCTIONS, /only when it points at that work explicitly/);
  await looper.stop();
});

test("an answer that calls nothing, or names work that isn't in a turn, starts new work titled by what came in", async () => {
  const { looper, values, asked } = looperWith({
    routing: (text) => (text.includes("One") ? says("It looks new.") : routeTo("nowhere")),
  });
  await looper.send("a", "\nOne  thing.\nAnd more.");
  await looper.send("b", "Two things.");
  await until(() => asked.length === 2, "both turns");
  assert.deepEqual(values.get("work/a"), { title: "One thing.", follows: ["a"] });
  assert.deepEqual(values.get("work/b"), { title: "Two things.", follows: ["b"] });
  await looper.stop();
});

test("a thread kept before works had records is its own work: the main loop is not asked", async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const message = (role: "user" | "assistant", content: string): Json => ({
    id: content,
    role,
    at,
    items: [{ type: "message", role, content }],
  });
  const values = new Map<string, Json>([
    ["thread/a/msg/000000000001", message("user", "Earlier.")],
    ["thread/a/msg/000000000002", message("assistant", "Answered.")],
  ]);
  const { looper, asked, routed, inputs } = looperWith({ values });
  await looper.send("a", "And now?");
  await until(() => asked.length === 1, "its turn");
  assert.deepEqual(routed, []);
  assert.deepEqual(inputs[0], ["Earlier.", "Answered.", "And now?"]);
  assert.equal(values.has("work/a"), false);
  await looper.stop();
});

test("a message the main loop gives to work under way is answered by that work, in the thread it came in", async () => {
  const { looper, values, said, asked, routed, inputs, answer } = looperWith({
    // The second thread's message carries on the first one's work.
    routing: (text) => (text.includes("Add a chart.") ? routeTo("a") : newWork("The report")),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("c", "Add a chart.");
  await until(() => routed.length === 2, "the main loop to be asked");
  // It was offered the work at work, by its id and title.
  assert.equal(routed[1], put(["Add a chart."], [{ id: "a", title: "The report" }]));
  answer("Write the report.", says("Report done."));
  // The work's turn takes the message at its next request, after the reply that hadn't read it.
  await until(() => asked.length === 2, "the request that reads it");
  assert.deepEqual(inputs[1], ["Write the report.", "Report done.", "Add a chart."]);
  answer("Add a chart.", says("Chart added."));
  await looper.settled();
  // Each thread shows what was said in it: the answer is where the message came in.
  assert.deepEqual(await texts(looper, "a"), ["Write the report.", "Report done."]);
  assert.deepEqual(await texts(looper, "c"), ["Add a chart.", "Chart added."]);
  assert.ok(said.includes("c: assistant: Chart added."));
  assert.deepEqual(values.get("work/a"), { title: "The report", follows: ["a", "c"] });
  assert.equal(values.has("work/c"), false);

  // From then on a message in either thread is that work's, and it reads all of it.
  await looper.send("c", "Make it a bar chart.");
  await until(() => asked.length === 3, "the next turn");
  assert.equal(routed.length, 2);
  assert.deepEqual(inputs[2], [
    "Write the report.",
    "Report done.",
    "Add a chart.",
    "Chart added.",
    "Make it a bar chart.",
  ]);
  answer("Make it a bar chart.", says("Bars."));
  await looper.settled();
  await looper.send("a", "Thanks.");
  await until(() => asked.length === 4, "a turn from the first thread");
  assert.equal(inputs[3]?.at(-1), "Thanks.");
  answer("Thanks.", says("Any time."));
  await looper.settled();
  assert.deepEqual(await texts(looper, "a"), [
    "Write the report.",
    "Report done.",
    "Thanks.",
    "Any time.",
  ]);

  // A looper made again on the same store knows what follows what.
  const again = looperWith({ values });
  await again.looper.send("c", "One more thing.");
  await until(() => again.asked.length === 1, "the work's turn");
  assert.deepEqual(again.routed, []);
  assert.equal(again.inputs[0]?.length, 9);
  await again.looper.stop();
});

test("messages said in a thread while the main loop decides are kept at once and go with the first", async () => {
  const deciding = gate();
  const { looper, said, asked, routed, inputs } = looperWith({
    routing: () => deciding.shut.then(() => newWork()),
  });
  await looper.send("a", "First.");
  await looper.send("a", "Second.");
  assert.deepEqual(said, ["a: user: First.", "a: user: Second."]);
  await idle();
  assert.equal(routed.length, 1, "one decision for the thread");
  assert.deepEqual(asked, []);
  deciding.open();
  await until(() => asked.length === 1, "the work's request");
  assert.deepEqual(inputs[0], ["First.", "Second."]);
  await looper.stop();
});

test("a message being kept as the main loop's decision is taken goes to that work with the first", async () => {
  const deciding = gate();
  const keeping = gate();
  const taking = gate();
  let marks = 0;
  let first: string | undefined;
  const { looper, asked, inputs, answer } = looperWith({
    routing: (text) =>
      text.includes("Add a chart.") ? deciding.shut.then(() => routeTo("a")) : newWork(),
    writing(key) {
      // The thread's second message waits to be kept, while the first one's work is decided.
      if (key === "unrouted/c") return ++marks === 2 ? keeping.shut : undefined;
      if (!key.startsWith("thread/c/")) return undefined;
      // And the first, written again as that work's, waits too.
      if (key === first) return taking.shut;
      first ??= key;
      return undefined;
    },
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("c", "Add a chart.");
  const second = looper.send("c", "In blue.");
  await until(() => marks === 2, "the second message to be on its way");
  deciding.open();
  await idle();
  keeping.open();
  await second;
  await idle();
  taking.open();
  answer("Write the report.", says("Report done."));
  await until(() => asked.length === 2, "the request that reads them");
  assert.deepEqual(inputs[1], ["Write the report.", "Report done.", "Add a chart.", "In blue."]);
  await looper.stop();
});

test("threads given to the same work one after another are both followed, and read in the order they came", async () => {
  const { looper, values, asked, routed, inputs, answer } = looperWith({
    routing: (text) => (text.includes("Write") ? newWork("The report") : routeTo("a")),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("c", "Add a chart.");
  await looper.send("d", "And a table.");
  await until(() => !values.has("unrouted/d") && routed.length === 3, "both to be given");
  // The second decision was made once the first had been taken.
  assert.match(String(routed[2]), /^Work under way:\n- a: The report\n/);
  assert.deepEqual(values.get("work/a"), { title: "The report", follows: ["a", "c", "d"] });
  answer("Write the report.", says("Report done."));
  await until(() => asked.length === 2, "the request that reads them");
  assert.deepEqual(inputs[1], [
    "Write the report.",
    "Report done.",
    "Add a chart.",
    "And a table.",
  ]);
  await looper.stop();
});

test("a turn that fails tells every thread it had taken a message in", async () => {
  const { looper, asked, routed, failures, fail } = looperWith({
    routing: (text) => (text.includes("Write") ? newWork() : routeTo("a")),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("c", "Add a chart.");
  await until(() => routed.length === 2, "the main loop to be asked");
  await idle();
  fail("Write the report.");
  await until(() => failures.length === 2, "both threads to be told");
  assert.deepEqual(failures, ["a: cancelled", "c: cancelled"]);
  await looper.stop();
});

test("a main loop that can't be asked leaves the message with no answer, and the next is put to it with the first", async () => {
  let refuse = true;
  const { looper, values, asked, routed, failures, working, inputs } = looperWith({
    routing: () => (refuse ? Promise.reject(new Error("no")) : undefined),
  });
  await looper.send("a", "First.");
  await until(() => failures.length === 1, "the message to be told it got no answer");
  assert.deepEqual(failures, ["a: failed"]);
  assert.deepEqual(working, [true, false]);
  assert.deepEqual(asked, []);
  // It waits for the thread's next message, not for the next start.
  assert.equal(values.get("unrouted/a"), false);
  refuse = false;
  await looper.send("a", "Second.");
  await until(() => asked.length === 1, "the work's request");
  assert.equal(routed[1], "No work is under way.\n\nWhat came in:\nFirst.\n\nSecond.");
  assert.deepEqual(inputs[0], ["First.", "Second."]);
  assert.equal(values.has("unrouted/a"), false);
  await looper.stop();
});

test("a waiting message the store won't give to its work stays waiting, and goes with the thread's next", async () => {
  let refuse = true;
  let first: string | undefined;
  const { looper, values, asked, failures, inputs, answer } = looperWith({
    routing: (text) => (text.includes("Write") ? newWork() : routeTo("a")),
    writing(key) {
      if (!key.startsWith("thread/c/")) return undefined;
      // Kept once; written again as the work's, it is refused.
      if (key === first && refuse) return Promise.reject(new Error("no"));
      first ??= key;
      return undefined;
    },
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("c", "Add a chart.");
  await until(() => failures.length === 1, "the thread to be told");
  assert.deepEqual(failures, ["c: failed"]);
  assert.equal(values.get("unrouted/c"), false);
  refuse = false;
  await looper.send("c", "In blue.");
  assert.equal(values.has("unrouted/c"), false);
  answer("Write the report.", says("Report done."));
  await until(() => asked.length === 2, "the request that reads them");
  assert.deepEqual(inputs[1], ["Write the report.", "Report done.", "Add a chart.", "In blue."]);
  await looper.stop();
});

test("a message waiting for the main loop as the looper goes is placed by the next, once", async () => {
  const never = gate();
  const first = looperWith({ routing: () => never.shut.then(() => newWork()) });
  await first.looper.send("a", "Before it went.");
  await until(() => first.routed.length === 1, "the main loop to be asked");
  await first.looper.close();
  await first.looper.settled();
  assert.equal(first.values.get("unrouted/a"), true);

  // Gone again while the main loop is asked the second time: the start after that asks no more.
  const cut = looperWith({
    values: new Map(first.values),
    routing: () => never.shut.then(() => newWork()),
  });
  await cut.looper.resume();
  await until(() => cut.routed.length === 1, "the main loop to be asked again");
  await cut.looper.close();
  await cut.looper.settled();
  const third = looperWith({ values: cut.values });
  await third.looper.resume();
  await idle();
  assert.deepEqual(third.routed, []);
  assert.equal(third.values.get("unrouted/a"), false);
  await third.looper.stop();

  const second = looperWith({ values: first.values });
  await second.looper.resume();
  await until(() => second.asked.length === 1, "the work's request");
  assert.equal(second.routed.length, 1);
  assert.deepEqual(second.inputs[0], ["Before it went."]);
  assert.equal(second.values.has("unrouted/a"), false);
  await second.looper.stop();
});

test("a stopped looper places nothing that waited: the thread's next message is put with it", async () => {
  const never = gate();
  const first = looperWith({ routing: () => never.shut.then(() => newWork()) });
  await first.looper.send("a", "Before it went.");
  await until(() => first.routed.length === 1, "the main loop to be asked");
  await first.looper.close();
  await first.looper.settled();

  const stopped = looperWith({ values: first.values, stopped: true });
  await stopped.looper.resume();
  assert.equal(stopped.values.get("unrouted/a"), false);
  stopped.looper.start();
  await idle();
  assert.deepEqual(stopped.routed, []);
  await stopped.looper.send("a", "And this.");
  await until(() => stopped.asked.length === 1, "its work's turn");
  assert.equal(stopped.routed.length, 1);
  assert.deepEqual(stopped.inputs[0], ["Before it went.", "And this."]);
  await stopped.looper.stop();
});

test("stopping cuts the main loop too, and what it was deciding starts nothing", async () => {
  const deciding = gate();
  const { looper, values, asked, working, failures, inputs } = looperWith({
    routing: () => deciding.shut.then(() => newWork()),
  });
  await looper.send("a", "First.");
  await idle();
  await looper.stop();
  deciding.open();
  await idle();
  assert.deepEqual(asked, []);
  assert.deepEqual(failures, []);
  assert.deepEqual(working, [true, false]);
  assert.equal(values.get("unrouted/a"), false);
  // Started again, the thread's next message is put to the main loop with the one before it.
  looper.start();
  await looper.send("a", "Second.");
  await until(() => asked.length === 1, "its work's turn");
  assert.deepEqual(inputs[0], ["First.", "Second."]);
  assert.equal(values.has("unrouted/a"), false);
  await looper.stop();
});

test("stopping answers though the main loop's request never ends", async () => {
  const { looper, routed, asked, working } = looperWith({
    deaf: true,
    routing: () => new Promise(() => {}),
  });
  await looper.send("a", "First.");
  await looper.send("b", "Second.");
  await until(() => routed.length === 1, "the main loop to be asked");
  await looper.stop();
  assert.deepEqual(asked, []);
  assert.deepEqual(working, [true, false]);
  // The second thread's decision, which waited for the first, was never asked for.
  assert.equal(routed.length, 1);
});

test("a stop that lands once the main loop has decided starts nothing; the decision stands", async () => {
  const keeping = gate();
  let reached = false;
  const { looper, values, asked, routed, working, inputs } = looperWith({
    writing(key) {
      if (key !== "work/a") return undefined;
      reached = true;
      return keeping.shut;
    },
  });
  await looper.send("a", "First.");
  await until(() => reached, "the decision to be on its way to the store");
  const stopping = looper.stop();
  keeping.open();
  await stopping;
  await idle();
  assert.deepEqual(asked, []);
  assert.deepEqual(working, [true, false]);
  assert.equal(values.has("unfinished/a"), false);
  assert.equal(values.get("unrouted/a"), false);
  // Its work is decided: the next message goes to it by code, with the one that waited.
  looper.start();
  await looper.send("a", "Second.");
  await until(() => asked.length === 1, "its work's turn");
  assert.equal(routed.length, 1);
  assert.deepEqual(inputs[0], ["First.", "Second."]);
  assert.equal(values.has("unrouted/a"), false);
  await looper.stop();
});

test("a close that lands once the main loop has decided leaves the message for the next looper, once", async () => {
  const keeping = gate();
  let reached = false;
  const first = looperWith({
    writing(key) {
      if (key !== "work/a") return undefined;
      reached = true;
      return keeping.shut;
    },
  });
  await first.looper.send("a", "First.");
  await until(() => reached, "the decision to be on its way to the store");
  await first.looper.close();
  keeping.open();
  await first.looper.settled();
  await idle();
  assert.deepEqual(first.asked, []);
  assert.equal(first.values.get("unrouted/a"), true);

  const second = looperWith({ values: first.values });
  await second.looper.resume();
  await until(() => second.asked.length === 1, "the work's request");
  // Decided already: the main loop isn't asked again.
  assert.deepEqual(second.routed, []);
  assert.deepEqual(second.inputs[0], ["First."]);
  assert.equal(second.values.has("unrouted/a"), false);
  await second.looper.stop();
});

test("a stop that lands as a thread's messages are given to work in a turn starts no turn after it", async () => {
  const taking = gate();
  let first: string | undefined;
  let reached = false;
  const { looper, asked, working, inputs } = looperWith({
    routing: (text) => (text.includes("Write") ? newWork() : routeTo("a")),
    writing(key) {
      if (!key.startsWith("thread/c/")) return undefined;
      if (key === first) {
        reached = true;
        return taking.shut;
      }
      first ??= key;
      return undefined;
    },
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("c", "Add a chart.");
  await until(() => reached, "the message to be on its way to the work");
  const stopping = looper.stop();
  taking.open();
  await stopping;
  await idle();
  assert.equal(asked.length, 1);
  assert.deepEqual(looper.state("a"), { state: "idle" });
  assert.equal(working.at(-1), false);
  // It is that work's all the same, and read with the next message.
  looper.start();
  await looper.send("c", "In blue.");
  await until(() => asked.length === 2, "the next turn");
  assert.deepEqual(inputs[1], ["Write the report.", "Add a chart.", "In blue."]);
  await looper.stop();
});

test("a stop that lands as what waited is looked for places nothing, also once started again", async () => {
  const never = gate();
  const first = looperWith({ routing: () => never.shut.then(() => newWork()) });
  await first.looper.send("a", "Before it went.");
  await until(() => first.routed.length === 1, "the main loop to be asked");
  await first.looper.close();
  await first.looper.settled();

  const reading = gate();
  let reached = false;
  const { looper, values, asked, routed } = looperWith({
    values: first.values,
    reading(key) {
      if (key !== "unrouted/a") return undefined;
      reached = true;
      return reading.shut;
    },
  });
  const going = looper.resume();
  await until(() => reached, "the mark to be read");
  // The stop waits for the look under way, and a start before it answers changes nothing.
  const stopping = looper.stop();
  looper.start();
  reading.open();
  await stopping;
  await going;
  await idle();
  assert.deepEqual(routed, []);
  assert.deepEqual(asked, []);
  assert.equal(values.get("unrouted/a"), false);
});

test("a stop that lands as the store is first read leaves nothing to go on with at the next start", async () => {
  const never = gate();
  const first = looperWith({ routing: () => never.shut.then(() => newWork()) });
  await first.looper.send("a", "Before it went.");
  await until(() => first.routed.length === 1, "the main loop to be asked");
  await first.looper.close();
  await first.looper.settled();

  const listing = gate();
  let reached = false;
  const second = looperWith({
    values: first.values,
    reading(key) {
      if (key !== "work/") return undefined;
      reached = true;
      return listing.shut;
    },
  });
  const going = second.looper.resume();
  await until(() => reached, "the works to be listed");
  const stopping = second.looper.stop();
  listing.open();
  await stopping;
  await going;
  assert.equal(second.values.get("unrouted/a"), false);
  assert.deepEqual(second.routed, []);
});

test("a message kept in a thread marked with nothing in it is put to the main loop, and is one work's", async () => {
  // As a looper leaves it that went between marking a thread and keeping its message.
  const values = new Map<string, Json>([["unrouted/c", true]]);
  const reading = gate();
  let reached = false;
  const { looper, asked, routed, inputs } = looperWith({
    values,
    reading(key) {
      // The thread's first read, which the look and the message both wait for.
      if (key !== "thread/c/msg/" || reached) return undefined;
      reached = true;
      return reading.shut;
    },
  });
  const going = looper.resume();
  await until(() => reached, "the thread to be read");
  const sent = looper.send("c", "First.");
  await idle();
  reading.open();
  await sent;
  await going;
  await until(() => asked.length === 1, "its work's turn");
  assert.equal(routed.length, 1);
  assert.deepEqual(inputs[0], ["First."]);
  assert.equal(values.has("unrouted/c"), false);
  await looper.stop();
});

test("a message kept as the main loop's failure is recorded is put to it too", async () => {
  let refuse = true;
  const marking = gate();
  let marks = 0;
  let reached = false;
  const { looper, asked, routed, failures, inputs } = looperWith({
    routing: () => (refuse ? Promise.reject(new Error("no")) : undefined),
    writing(key) {
      // The mark's second write says the first decision failed: held while a message comes.
      if (key !== "unrouted/a" || ++marks !== 2) return undefined;
      reached = true;
      return marking.shut;
    },
  });
  await looper.send("a", "First.");
  await until(() => reached, "the failure to be on its way to the store");
  assert.deepEqual(failures, ["a: failed"]);
  refuse = false;
  const sent = looper.send("a", "Second.");
  await idle();
  marking.open();
  await sent;
  await until(() => asked.length === 1, "its work's turn");
  assert.equal(routed.length, 2);
  assert.deepEqual(inputs[0], ["First.", "Second."]);
  await looper.stop();
});

test("the main loop is put the newest of what waits, and the start of each", async () => {
  let refuse = true;
  const { looper, routed, failures, asked } = looperWith({
    routing: () => (refuse ? Promise.reject(new Error("no")) : undefined),
  });
  for (let i = 0; i < 9; i++) {
    await looper.send("a", `${i}${"x".repeat(5000)}`);
    await until(() => failures.length === i + 1, "the failure to be told");
  }
  refuse = false;
  await looper.send("a", "Last.");
  await until(() => asked.length === 1, "its work's turn");
  const put = String(routed.at(-1)).split("What came in:\n")[1] ?? "";
  const parts = put.split("\n\n");
  assert.equal(parts.length, 8);
  assert.equal(parts[0], `2${"x".repeat(3999)}…`);
  assert.equal(parts.at(-1), "Last.");
  await looper.stop();
});

test("a close that lands as what waited is looked for leaves it for the next looper", async () => {
  const never = gate();
  const first = looperWith({ routing: () => never.shut.then(() => newWork()) });
  await first.looper.send("a", "Before it went.");
  await until(() => first.routed.length === 1, "the main loop to be asked");
  await first.looper.close();
  await first.looper.settled();

  const reading = gate();
  let reached = false;
  const second = looperWith({
    values: first.values,
    reading(key) {
      if (key !== "unrouted/a") return undefined;
      reached = true;
      return reading.shut;
    },
  });
  const going = second.looper.resume();
  await until(() => reached, "the mark to be read");
  await second.looper.close();
  reading.open();
  await going;
  await idle();
  assert.deepEqual(second.routed, []);
  assert.equal(second.values.get("unrouted/a"), true);

  const third = looperWith({ values: second.values });
  await third.looper.resume();
  await until(() => third.asked.length === 1, "the work's request");
  assert.deepEqual(third.inputs[0], ["Before it went."]);
  await third.looper.stop();
});

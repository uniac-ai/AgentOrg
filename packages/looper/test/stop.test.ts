import assert from "node:assert/strict";
import test from "node:test";
import { HEARD_INSTRUCTIONS, MAIN_INSTRUCTIONS, ROUTE } from "../src/main.ts";
import {
  gate,
  held,
  idle,
  looperWith,
  newWork,
  route,
  routeTo,
  says,
  stops,
  until,
} from "./support.ts";

const worksIn = (values: Map<string, unknown>) =>
  [...values.keys()].filter((key) => key.startsWith("work/")).sort();

test("a message that joins a turn is that turn's, and the main loop hears of it and places nothing", async () => {
  const { looper, values, said, asked, mains, working, inputs, answer } = looperWith({
    voice: "You are Scout.",
    // What it would say or place is nothing here: it may only stop.
    routing: (text) => (text === "And a summary." ? [...says("On it."), ...newWork()] : newWork()),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  // The message that started the turn was decided on, and is not heard of again.
  assert.equal(mains.length, 1);
  assert.match(String(mains[0]?.instructions), /You are Scout\./);
  await looper.send("a", "And a summary.");
  await until(() => mains.length === 2, "the main loop to hear of it");
  // It is given that work and that message, in its own words alone: not who it speaks as.
  assert.deepEqual(mains[1], {
    instructions: HEARD_INSTRUCTIONS,
    tools: [ROUTE],
    input: ["The work there is:\n- a: Work (in a turn)", "And a summary."],
  });
  answer("Write the report.", says("Report done."));
  await until(() => asked.length === 2, "the request that reads it");
  assert.deepEqual(inputs[1], ["Write the report.", "Report done.", "And a summary."]);
  answer("And a summary.", says("Summary done."));
  await looper.settled();
  assert.deepEqual(said, [
    "a: user: Write the report.",
    "a: user: And a summary.",
    "a: assistant: Report done.",
    "a: assistant: Summary done.",
  ]);
  assert.deepEqual(working, [true, false]);
  assert.deepEqual(worksIn(values), ["work/a"]);
});

test("stop said to work in a turn cuts that turn: the thread says so, and its next message goes on with what was said", async () => {
  const { looper, values, said, asked, mains, working, inputs } = looperWith({
    routing: (text) =>
      text === "Stop." ? [...says("Stopped the report."), ...stops("a")] : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("a", "Stop.");
  await until(() => said.length === 3, "the thread to be told");
  await looper.settled();
  assert.deepEqual(said, [
    "a: user: Write the report.",
    "a: user: Stop.",
    "a: assistant: Stopped the report.",
  ]);
  // It is at rest: nothing runs, nothing is marked to go on, and nothing failed.
  assert.deepEqual(looper.state("a"), { state: "idle" });
  assert.deepEqual(working, [true, false]);
  assert.equal(values.has("unfinished/a"), false);
  assert.equal((values.get("work/a") as { failed?: true }).failed, undefined);
  // The next message there starts a turn that reads what was said, the main loop's word too.
  // It starts that turn, so the main loop is not told of it.
  await looper.send("a", "Go on, but shorter.");
  await until(() => asked.length === 2, "its next turn");
  assert.deepEqual(inputs[1], [
    "Write the report.",
    "Stop.",
    "Stopped the report.",
    "Go on, but shorter.",
  ]);
  await idle();
  assert.equal(mains.length, 2);
  await looper.stop();
});

test("a stop with nothing said beside it is said in the looper's own word; text without a stop, or with a stop of other work, is not said", async () => {
  const { looper, said, asked, mains } = looperWith({
    routing: (text) =>
      text === "Stop."
        ? stops("a")
        : text === "Hm."
          ? says("I see.")
          : text === "Stop the other."
            ? [...says("Stopped it."), ...stops("b")]
            : newWork(),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("a", "Hm.");
  await looper.send("a", "Stop the other.");
  await until(() => mains.length === 3, "the main loop to hear of both");
  await idle();
  assert.deepEqual(said, [
    "a: user: Write the report.",
    "a: user: Hm.",
    "a: user: Stop the other.",
  ]);
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  await looper.send("a", "Stop.");
  await until(() => said.length === 5, "the thread to be told");
  assert.equal(said[4], "a: assistant: Stopped.");
  await looper.settled();
});

test("a message the main loop can't hear of is the turn's all the same, and nothing is said of it", async () => {
  const { looper, said, asked, mains, failures, answer } = looperWith({
    routing: (text) =>
      text === "Stop." ? Promise.reject(new Error("the model refused it")) : newWork(),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("a", "Stop.");
  await until(() => mains.length === 2, "the main loop to be asked");
  answer("Write the report.", says("Report done."));
  await until(() => asked.length === 2, "the request that reads it");
  answer("Stop.", says("Stopping here."));
  await looper.settled();
  assert.deepEqual(said.slice(2), ["a: assistant: Report done.", "a: assistant: Stopping here."]);
  assert.deepEqual(failures, []);
});

test("stop said in a thread nothing follows stops the work it points at: only that thread is told, and it stays no work's", async () => {
  const { looper, values, said, asked, mains, inputs } = looperWith({
    routing: (text) =>
      text === "Stop the report."
        ? [...says("Stopped the report."), ...stops("a")]
        : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("b", "Stop the report.");
  await until(() => said.includes("b: assistant: Stopped the report."), "the answer");
  await looper.settled();
  assert.equal(mains[1]?.input[0], "The work there is:\n- a: The report (in a turn)");
  assert.deepEqual(looper.state("a"), { state: "idle" });
  assert.deepEqual(worksIn(values), ["work/a"]);
  assert.equal(values.get("unrouted/b"), false);
  assert.equal(asked.length, 1);
  // The work's own thread holds nothing of it, and its next turn reads none of it.
  assert.deepEqual(
    said.filter((line) => line.startsWith("a: ")),
    ["a: user: Write the report."],
  );
  await looper.send("a", "Go on.");
  await until(() => asked.length === 2, "its next turn");
  assert.deepEqual(inputs[1], ["Write the report.", "Go on."]);
  await looper.stop();
});

test("a call that names work to stop only stops: beside a work or a title nothing is placed, and with nothing written it says whether anything was stopped", async () => {
  const { looper, values, said, asked } = looperWith({
    routing: (text) =>
      text === "Stop the report."
        ? route({ stop: "a", work: "a", title: "Stopping" })
        : text === "Stop the chart."
          ? route({ stop: "chart" })
          : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("b", "Stop the report.");
  await until(() => said.includes("b: assistant: Stopped."), "the answer");
  assert.deepEqual(looper.state("a"), { state: "idle" });
  // Work that isn't there, or isn't in a turn: nothing is stopped, and no work starts for it.
  await looper.send("c", "Stop the chart.");
  await until(() => said.includes("c: assistant: Nothing was stopped."), "the answer");
  await looper.send("d", "Stop the report.");
  await until(() => said.includes("d: assistant: Nothing was stopped."), "the answer");
  await looper.settled();
  assert.deepEqual(worksIn(values), ["work/a"]);
  assert.deepEqual((values.get("work/a") as { follows: string[] }).follows, ["a"]);
  assert.equal(asked.length, 1);
});

test("a call with an empty stop places what came in as any other", async () => {
  const { looper, values, said, asked, answer } = looperWith({
    routing: (text) =>
      text === "Add a chart to the report."
        ? [...says("Passing it on."), ...route({ work: "a", stop: "" })]
        : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("b", "Add a chart to the report.");
  await until(() => said.includes("b: assistant: Passing it on."), "what it said");
  answer("Write the report.", says("Report done."));
  await until(() => asked.length === 2, "the request that reads it");
  answer("Add a chart to the report.", says("Chart added."));
  await looper.settled();
  assert.deepEqual((values.get("work/a") as { follows: string[] }).follows, ["a", "b"]);
  assert.equal(said.at(-1), "b: assistant: Chart added.");
});

test("a stop of work that is at rest starts no work, and what the main loop wrote is the answer", async () => {
  const { looper, values, said, asked, answer } = looperWith({
    routing: (text) =>
      text.startsWith("Stop")
        ? [...says("Nothing is running. The report is at rest."), ...stops("a")]
        : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  answer("Write the report.", says("Report done."));
  await looper.settled();
  await looper.send("b", "Stop it.");
  await until(
    () => said.at(-1) === "b: assistant: Nothing is running. The report is at rest.",
    "the answer",
  );
  await looper.settled();
  assert.deepEqual(worksIn(values), ["work/a"]);
  assert.equal(asked.length, 1);
});

test("what the main loop says of a message stops the turn that message joined, and no turn after it", async () => {
  const hearing = gate();
  const { looper, said, asked, mains, answer } = looperWith({
    routing: (text) =>
      text === "Stop." ? hearing.shut.then(() => [...says("Stopped."), ...stops("a")]) : newWork(),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("a", "Stop.");
  await until(() => mains.length === 2, "the main loop to hear of it");
  // The worker reads the message itself and ends the turn; then the next message starts another.
  answer("Write the report.", says("Report done."));
  await until(() => asked.length === 2, "the request that reads it");
  answer("Stop.", says("It was done already."));
  await until(() => looper.state("a").state === "idle", "the turn to end");
  await looper.send("a", "Now translate it.");
  await until(() => asked.length === 3, "the next turn's request");
  hearing.open();
  await idle();
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  answer("Now translate it.", says("Translated."));
  await looper.settled();
  assert.deepEqual(said.slice(2), [
    "a: assistant: Report done.",
    "a: assistant: It was done already.",
    "a: user: Now translate it.",
    "a: assistant: Translated.",
  ]);
});

test("a decision to stop cuts the turn the main loop was told of, and no turn after it", async () => {
  const deciding = gate();
  const { looper, said, asked, mains, answer } = looperWith({
    routing: (text) =>
      text === "Stop the report." ? deciding.shut.then(() => stops("a")) : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("b", "Stop the report.");
  await until(() => mains.length === 2, "the main loop to be asked");
  answer("Write the report.", says("Report done."));
  await until(() => looper.state("a").state === "idle", "the turn to end");
  await looper.send("a", "Now translate it.");
  await until(() => asked.length === 2, "the next turn's request");
  deciding.open();
  // No turn was cut, and the asking thread is told so.
  await until(() => said.includes("b: assistant: Nothing was stopped."), "the answer");
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  answer("Now translate it.", says("Translated."));
  await looper.settled();
  assert.equal(said.at(-1), "a: assistant: Translated.");
});

test("the looper stopping drops what the main loop was to hear: nothing is said after", async () => {
  const hearing = gate();
  const { looper, said, asked, mains, working } = looperWith({
    routing: (text) =>
      text === "Stop." ? hearing.shut.then(() => [...says("Stopped."), ...stops("a")]) : newWork(),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("a", "Stop.");
  await until(() => mains.length === 2, "the main loop to hear of it");
  await looper.stop();
  hearing.open();
  await idle();
  assert.deepEqual(said, ["a: user: Write the report.", "a: user: Stop."]);
  assert.equal(working.at(-1), false);
});

test("the looper stopping or closing as a message joins a turn asks the main loop nothing after", async () => {
  for (const end of ["stop", "close"] as const) {
    const { looper, asked, mains } = looperWith();
    await looper.send("a", "Write the report.");
    await until(() => asked.length === 1, "the work's request");
    // The looper ends in the same breath as the message is said.
    const sending = looper.send("a", "Stop.");
    const ending = looper[end]();
    await sending.catch(() => {});
    await ending;
    await idle();
    assert.equal(mains.length, 1, end);
  }
});

test("a second message that joined a turn the first one stopped is not put to the main loop", async () => {
  const { looper, said, asked, mains } = looperWith({
    routing: (text) => (text === "Stop." ? stops("a") : newWork()),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("a", "Stop.");
  await looper.send("a", "Really.");
  await until(() => said.includes("a: assistant: Stopped."), "the thread to be told");
  await looper.settled();
  // The decision, and one hearing: the turn the second message joined had been cut.
  assert.equal(mains.length, 2);
  assert.deepEqual(said.slice(1), ["a: user: Stop.", "a: user: Really.", "a: assistant: Stopped."]);
});

test("stop said in a second thread the work follows is said there, and the work reads it in the order it was said", async () => {
  const { looper, said, asked, inputs, answer } = looperWith({
    routing: (text) =>
      text === "Add a chart to the report."
        ? routeTo("a")
        : text === "Stop."
          ? stops("a")
          : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("b", "Add a chart to the report.");
  answer("Write the report.", says("Report done."));
  await until(() => asked.length === 2, "the request that reads the second thread's message");
  await looper.send("b", "Stop.");
  await until(() => said.includes("b: assistant: Stopped."), "the second thread to be told");
  await looper.settled();
  assert.deepEqual(looper.state("a"), { state: "idle" });
  await looper.send("a", "Go on.");
  await until(() => asked.length === 3, "its next turn");
  assert.deepEqual(inputs[2], [
    "Write the report.",
    "Report done.",
    "Add a chart to the report.",
    "Stop.",
    "Stopped.",
    "Go on.",
  ]);
  await looper.stop();
});

test("stopped while a call runs, the thread is told at once, and the next message is kept and said at once; its turn reads the call's result first", async () => {
  const { tool, called, finish } = held();
  const { looper, values, said, asked, mains, inputs, working, answer } = looperWith({
    tools: [tool],
    routing: (text) => (text === "Stop." ? stops("a") : newWork("The report")),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  answer("Write the report.", called);
  await until(() => said.includes("a: tool: hold: running"), "the call to start");
  await looper.send("a", "Stop.");
  await until(() => said.includes("a: assistant: Stopped."), "the thread to be told");
  // A message said now is kept and said, and its turn shows as running, while the call runs.
  const sending = looper.send("a", "Go on.");
  await until(() => said.at(-1) === "a: user: Go on.", "the message to be said");
  await sending;
  assert.equal((await looper.page("a", undefined, 50)).messages.at(-1)?.text, "Go on.");
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  assert.equal(working.at(-1), true);
  await idle();
  assert.equal(asked.length, 1);
  // It started that turn, so the main loop is not told of it.
  assert.equal(mains.length, 2);
  finish();
  await until(() => asked.length === 2, "its next turn");
  // The model reads the call it made right after what it had read, then what was said since.
  const read = ["Write the report.", "call hold", "output held", "Stop.", "Stopped.", "Go on."];
  assert.deepEqual(inputs[1], read);
  await looper.close();
  // The same from the store.
  const second = looperWith({ values, tools: [tool] });
  await second.looper.send("a", "Again.");
  await until(() => second.asked.length === 1, "its turn");
  assert.deepEqual(second.inputs[0], [...read, "Again."]);
  await second.looper.stop();
});

test("work whose stopped turn's call still runs holds one place, also with a turn that waits for the call, and after that turn is stopped too", async () => {
  const { tool, called, finish } = held();
  const { looper, said, asked, answer } = looperWith({
    tools: [tool],
    routing: (text) => (text.startsWith("Stop") ? stops("a") : newWork("The report")),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  answer("Write the report.", called);
  await until(() => said.includes("a: tool: hold: running"), "the call to start");
  await looper.send("a", "Stop.");
  await until(() => said.includes("a: assistant: Stopped."), "the thread to be told");
  await looper.send("a", "Go on.");
  assert.deepEqual(looper.state("a"), { state: "thinking" });
  // Three more turns run beside it, and a fourth waits for a place.
  for (const thread of ["b", "c", "d", "e"]) await looper.send(thread, `Work ${thread}.`);
  await until(() => asked.length === 4, "three more requests");
  await idle();
  assert.deepEqual(asked.slice(1).sort(), ["Work b.", "Work c.", "Work d."]);
  // The waiting turn stopped, the place is still its work's while the call runs.
  await looper.send("a", "Stop again.");
  await until(() => looper.state("a").state === "idle", "the waiting turn to be cut");
  await idle();
  assert.equal(asked.length, 4);
  // The call ends: nothing is asked for that work, and its place goes to the turn that waited.
  finish();
  await until(() => asked.length === 5, "the fourth to get its place");
  await idle();
  assert.deepEqual(asked.slice(4), ["Work e."]);
  await looper.stop();
});

test("a turn that waits for a stopped turn's call, stopped while its message is stored and then refused, leaves no place taken", async () => {
  const { tool, called, finish } = held();
  const late = gate();
  let holding = false;
  const { looper, said, asked, answer } = looperWith({
    tools: [tool],
    writing: (key) => (holding && key.startsWith("thread/a/msg/") ? late.shut : undefined),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  answer("Write the report.", called);
  await until(() => said.includes("a: tool: hold: running"), "the call to start");
  await looper.cancel("a");
  holding = true;
  const sending = looper.send("a", "Go on.").then(
    () => "kept",
    () => "refused",
  );
  await idle();
  await looper.cancel("a");
  late.fail();
  assert.equal(await sending, "refused");
  holding = false;
  finish();
  await idle();
  // Every place is free: four pieces of new work run at once.
  for (const thread of ["b", "c", "d", "e"]) await looper.send(thread, `Work ${thread}.`);
  await until(() => asked.length === 5, "four requests");
  await looper.stop();
});

test("a message asked before a stop and taken after it is kept before what the main loop says", async () => {
  const { tool, called, finish } = held();
  const hearing = gate();
  let slow: ReturnType<typeof gate> | undefined;
  const { looper, said, asked, mains, answer } = looperWith({
    tools: [tool],
    writing: (key) => (key.startsWith("thread/a/msg/") ? slow?.shut : undefined),
    routing: (text) =>
      text === "Stop."
        ? hearing.shut.then(() => stops("a"))
        : text.startsWith("And") || text.startsWith("Also")
          ? []
          : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  answer("Write the report.", called);
  await until(() => said.includes("a: tool: hold: running"), "the call to start");
  await looper.send("a", "Stop.");
  await until(() => mains.length === 2, "the main loop to hear of it");
  // One message is being stored and another waits behind it when the main loop says stop.
  slow = gate();
  const sending = [looper.send("a", "And a chart."), looper.send("a", "Also a table.")];
  await idle();
  hearing.open();
  await idle();
  slow.open();
  slow = undefined;
  await Promise.all(sending);
  await until(() => said.includes("a: assistant: Stopped."), "the thread to be told");
  assert.deepEqual(said.slice(-3), [
    "a: user: And a chart.",
    "a: user: Also a table.",
    "a: assistant: Stopped.",
  ]);
  finish();
  await looper.stop();
});

test("a looper that closes while a turn waits for a stopped turn's call leaves it to go on, and its message is read once", async () => {
  const { tool, called } = held();
  const first = looperWith({
    tools: [tool],
    routing: (text) => (text === "Stop." ? stops("a") : newWork("The report")),
  });
  await first.looper.send("a", "Write the report.");
  await until(() => first.asked.length === 1, "the work's request");
  first.answer("Write the report.", called);
  await until(() => first.said.includes("a: tool: hold: running"), "the call to start");
  await first.looper.send("a", "Stop.");
  await until(() => first.said.includes("a: assistant: Stopped."), "the thread to be told");
  const sending = first.looper.send("a", "Do the summary instead.");
  await until(() => first.said.at(-1) === "a: user: Do the summary instead.", "it to be said");
  await sending;
  // Closed with the call still running: its result is never kept.
  await first.looper.close();
  assert.equal(first.values.has("unfinished/a"), true);

  const second = looperWith({ values: first.values, tools: [tool] });
  await second.looper.resume();
  await until(() => second.asked.length === 1, "the turn to go on");
  assert.deepEqual(
    second.inputs[0]?.filter((line) => line === "Do the summary instead."),
    ["Do the summary instead."],
  );
  assert.deepEqual(second.inputs[0]?.slice(0, 4), [
    "Write the report.",
    "Stop.",
    "Stopped.",
    "Do the summary instead.",
  ]);
  second.answer(second.asked[0] as string, says("Summary done."));
  await second.looper.settled();
  assert.equal(second.asked.length, 1);
  assert.equal(second.values.has("unfinished/a"), false);
});

test("work whose stopped turn's call still runs takes a second thread's message at once, and reads it after that call's result", async () => {
  const { tool, called, finish } = held();
  const { looper, said, asked, mains, inputs, answer } = looperWith({
    tools: [tool],
    routing: (text) =>
      text === "Stop."
        ? stops("a")
        : text === "Add a chart to the report."
          ? routeTo("a")
          : newWork("The report"),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  answer("Write the report.", called);
  await until(() => said.includes("a: tool: hold: running"), "the call to start");
  await looper.send("a", "Stop.");
  await until(() => said.includes("a: assistant: Stopped."), "the thread to be told");
  // It is told of as at rest while the call runs, and a message that points at it is given to it.
  await looper.send("b", "Add a chart to the report.");
  await until(() => looper.state("a").state === "thinking", "the work to take it");
  assert.equal(mains[2]?.input[0], "The work there is:\n- a: The report (at rest)");
  await idle();
  assert.equal(asked.length, 1);
  finish();
  await until(() => asked.length === 2, "its next turn");
  assert.deepEqual(inputs[1], [
    "Write the report.",
    "call hold",
    "output held",
    "Stop.",
    "Stopped.",
    "Add a chart to the report.",
  ]);
  await looper.stop();
});

test("stopped during a call made after the request had read the stop, that call's result is read before what the main loop said", async () => {
  const gates = [gate(), gate()];
  let calls = 0;
  const tool = {
    name: "hold",
    parameters: {},
    run: async () => {
      await gates[calls++]?.shut;
      return { output: "held", ok: true };
    },
  };
  const call = (callId: string) => [
    { type: "function_call" as const, callId, name: "hold", arguments: "{}" },
  ];
  const hearing = gate();
  const { looper, said, asked, inputs, answer } = looperWith({
    tools: [tool],
    routing: (text) => (text === "Stop." ? hearing.shut.then(() => stops("a")) : newWork()),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  answer("Write the report.", call("c1"));
  await until(() => calls === 1, "the first call to start");
  await looper.send("a", "Stop.");
  // The first call ends, and the next request reads the message; the model calls again.
  gates[0]?.open();
  await until(() => asked.length === 2, "the request that reads it");
  answer("Stop.", call("c2"));
  await until(() => calls === 2, "the second call to start");
  hearing.open();
  await until(() => said.includes("a: assistant: Stopped."), "the thread to be told");
  gates[1]?.open();
  await looper.send("a", "Go on.");
  await until(() => asked.length === 3, "its next turn");
  assert.deepEqual(inputs[2], [
    "Write the report.",
    "call hold",
    "output held",
    "Stop.",
    "call hold",
    "output held",
    "Stopped.",
    "Go on.",
  ]);
  await looper.stop();
});

test("the looper's stop waits for a line the main loop is having kept, and a line the store refuses is told to the thread", async () => {
  const line = gate();
  const { looper, said, asked, failures } = looperWith({
    writing: (key) => (key === "thread/a/msg/000000000003" ? line.shut : undefined),
    routing: (text) => (text === "Stop." ? stops("a") : newWork()),
  });
  await looper.send("a", "Write the report.");
  await until(() => asked.length === 1, "the work's request");
  await looper.send("a", "Stop.");
  await until(() => looper.state("a").state === "idle", "the turn to be cut");
  let stopped = false;
  const stopping = looper.stop().then(() => {
    stopped = true;
  });
  await idle();
  assert.equal(stopped, false);
  line.open();
  await stopping;
  assert.equal(said.at(-1), "a: assistant: Stopped.");

  const refused = gate();
  const second = looperWith({
    writing: (key) => (key === "thread/a/msg/000000000003" ? refused.shut : undefined),
    routing: (text) => (text === "Stop." ? stops("a") : newWork()),
  });
  await second.looper.send("a", "Write the report.");
  await until(() => second.asked.length === 1, "the work's request");
  await second.looper.send("a", "Stop.");
  await until(() => second.looper.state("a").state === "idle", "the turn to be cut");
  refused.fail();
  await second.looper.settled();
  assert.deepEqual(second.said, ["a: user: Write the report.", "a: user: Stop."]);
  assert.equal(second.failures.length, 1);
  assert.match(String(second.failures[0]), /^a: /);
  assert.deepEqual(failures, []);
});

test("work stopped from its thread is at rest for the next looper too: nothing goes on by itself", async () => {
  const first = looperWith({
    routing: (text) => (text === "Stop." ? stops("a") : newWork("The report")),
  });
  await first.looper.send("a", "Write the report.");
  await until(() => first.asked.length === 1, "the work's request");
  await first.looper.send("a", "Stop.");
  await until(() => first.said.includes("a: assistant: Stopped."), "the thread to be told");
  await first.looper.close();
  await first.looper.settled();

  const second = looperWith({ values: first.values });
  await second.looper.resume();
  await idle();
  assert.deepEqual(second.asked, []);
  assert.deepEqual(second.said, []);
  await second.looper.send("a", "Go on.");
  await until(() => second.asked.length === 1, "its next turn");
  assert.deepEqual(second.inputs[0], ["Write the report.", "Stop.", "Stopped.", "Go on."]);
  await second.looper.stop();
});

test("the main loop is told to stop only what a message asks to stop, and nothing in doubt", () => {
  assert.match(MAIN_INSTRUCTIONS, /when the message asks to stop it and exactly one piece of work/);
  assert.match(MAIN_INSTRUCTIONS, /If none fits, or more than one, stop nothing and call nothing/);
  assert.match(HEARD_INSTRUCTIONS, /Act only if the message asks to stop work/);
  assert.match(HEARD_INSTRUCTIONS, /If exactly one of those pieces of work fits/);
  assert.match(HEARD_INSTRUCTIONS, /more than one fits, call nothing and say which are in a turn/);
});

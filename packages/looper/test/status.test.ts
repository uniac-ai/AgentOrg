import assert from "node:assert/strict";
import test from "node:test";
import { SUMMARY_BEGINS } from "../src/compaction.ts";
import { Entry, type OutputItem, type Tool, textOf, type WorkEntry } from "../src/index.ts";
import { INPUT_BUDGET, REQUEST_BUDGET } from "../src/record.ts";
import { handsBack, looperWith, newWork, routeTo, says, sends, until } from "./support.ts";

const BACK = "That was given to this work, which handed it back:";

/** A worker calling `status` with `args`. */
const status = (args: unknown): OutputItem[] => [
  {
    type: "function_call",
    callId: `status-${crypto.randomUUID()}`,
    name: "status",
    arguments: JSON.stringify(args),
  },
];
/** What the calls of the latest request gave back, in order, as its next request was sent them. */
const outputs = (made: ReturnType<typeof looperWith>) =>
  (made.inputs.at(-1) ?? []).flatMap((line) =>
    line.startsWith("output ") ? [line.slice("output ".length)] : [],
  );
/** What the latest `status` answered. */
const answered = (made: ReturnType<typeof looperWith>) => outputs(made).at(-1);
/** A refusal's words, from the output that carries it. */
const refusal = (output: string) =>
  (JSON.parse(output) as { error: { message: string } }).error.message;
/** Each fact said, as `thread: text fact`, with `: step` while it is at one. */
const facts = (made: ReturnType<typeof looperWith>) =>
  made.progress.map((line) => {
    const [, thread = "", id = "", rest = ""] = /^(.*?): (\S+) (.*)$/.exec(line) ?? [];
    const kept = made.values.get(`thread/${encodeURIComponent(thread)}/msg/${id}`);
    return `${thread}: ${kept === undefined ? id : textOf(Entry.parse(kept))} ${rest}`;
  });
/** A thread's messages as a page read now shows them, each with what became of it. */
const page = async (looper: ReturnType<typeof looperWith>["looper"], thread: string) =>
  (await looper.page(thread, undefined, 50)).messages.map(({ text, progress }) =>
    progress === undefined
      ? text
      : `${text} (${progress.state}${progress.step === undefined ? "" : `: ${progress.step}`})`,
  );
/** The steps the piece of work `id` keeps, as `works()` gives them. */
const stepsOf = async (looper: ReturnType<typeof looperWith>["looper"], id = "a") =>
  (await looper.works(10, 0)).find((one) => one.id === id)?.steps;
/** The number the newest message of a request starts with: the request of the work that began with `first`. */
const numberIn = (numbered: string[][], first: string) => {
  const request = numbered.findLast((lines) => lines[0]?.includes(first));
  const newest = request?.findLast((line) => /^\[\d+\] /.test(line)) ?? "";
  return Number(/^\[(\d+)\]/.exec(newest)?.[1]);
};

test("set: the answer is the list, and works() gives the steps", async () => {
  const made = looperWith();
  await made.looper.send("a", "Plan the trip.");
  await until(() => made.asked.length === 1, "the request");
  const long = "x".repeat(300);
  made.answer(
    "Plan the trip.",
    status({
      steps: [
        { text: "Find flights", active: `Finding ${long}`, state: "in_progress" },
        { text: "Compare prices" },
        { text: ` ${long} `, active: "" },
      ],
    }),
  );
  await until(() => made.asked.length === 2, "the request after it");
  // Each step's words keep 200 characters; so do the step's words said on a message.
  const cut = `Finding ${long}`.slice(0, 200);
  assert.equal(
    answered(made),
    `1. in_progress: Find flights\n2. pending: Compare prices\n3. pending: ${"x".repeat(200)}`,
  );
  assert.deepEqual(await stepsOf(made.looper), [
    { text: "Find flights", active: cut, state: "in_progress" },
    { text: "Compare prices", state: "pending" },
    { text: "x".repeat(200), state: "pending" },
  ]);
  assert.deepEqual(facts(made), ["a: Plan the trip. taken", `a: Plan the trip. taken: ${cut}`]);
  made.answer("Plan the trip.", sends("Planned."));
  await made.looper.settled();
});

test("advance: completes the one in progress and starts the next pending; at the last, none in progress", async () => {
  const made = looperWith();
  await made.looper.send("a", "Plan the trip.");
  await until(() => made.asked.length === 1, "the request");
  const steps = async (call: OutputItem[]) => {
    const before = made.asked.length;
    made.answer("Plan the trip.", call);
    await until(() => made.asked.length === before + 1, "the request after it");
    return answered(made);
  };
  await steps(status({ steps: [{ text: "Find flights" }, { text: "Compare" }, { text: "Book" }] }));
  // With none in progress, the first pending one starts.
  assert.equal(
    await steps(status({ advance: true })),
    "1. in_progress: Find flights\n2. pending: Compare\n3. pending: Book",
  );
  assert.equal(
    await steps(status({ advance: true })),
    "1. completed: Find flights\n2. in_progress: Compare\n3. pending: Book",
  );
  assert.equal(
    await steps(status({ advance: true })),
    "1. completed: Find flights\n2. completed: Compare\n3. in_progress: Book",
  );
  assert.equal(
    await steps(status({ advance: true })),
    "1. completed: Find flights\n2. completed: Compare\n3. completed: Book",
  );
  // With none pending after the one in progress, the first pending one before it starts.
  await steps(status({ steps: [{ text: "A" }, { text: "B", state: "in_progress" }] }));
  assert.equal(await steps(status({ advance: true })), "1. in_progress: A\n2. completed: B");
  made.answer("Plan the trip.", sends("Planned."));
  await made.looper.settled();
  assert.deepEqual(await stepsOf(made.looper), [
    { text: "A", state: "in_progress" },
    { text: "B", state: "completed" },
  ]);
});

test("done and start: steps marked by number, out of order", async () => {
  const made = looperWith();
  await made.looper.send("a", "Plan the trip.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Plan the trip.", [
    ...status({ steps: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }] }),
    ...status({ start: 3 }),
    // The one in progress is completed by the same call's `done`, before the start.
    ...status({ done: [3, 1], start: 2 }),
    ...status({ done: [2] }),
  ]);
  await until(() => made.asked.length === 2, "the request after them");
  assert.deepEqual(outputs(made).slice(1), [
    "1. pending: A\n2. pending: B\n3. in_progress: C\n4. pending: D",
    "1. completed: A\n2. in_progress: B\n3. completed: C\n4. pending: D",
    "1. completed: A\n2. completed: B\n3. completed: C\n4. pending: D",
  ]);
  made.answer("Plan the trip.", sends("Planned."));
  await made.looper.settled();
});

test("each rule is refused to the model in its words, and changes nothing", async () => {
  const made = looperWith();
  await made.looper.send("a", "Plan the trip.");
  await until(() => made.asked.length === 1, "the request");
  const two = [{ text: "A", state: "in_progress" }, { text: "B" }];
  made.answer("Plan the trip.", [
    ...status({ advance: true }),
    ...status({ done: [1] }),
    ...status({ start: 1 }),
    ...status({ steps: Array.from({ length: 9 }, (_, i) => ({ text: `Step ${i + 1}` })) }),
    ...status({
      steps: [
        { text: "A", state: "in_progress" },
        { text: "B", state: "in_progress" },
      ],
    }),
    ...status({ steps: [{ text: "A" }, { text: "  " }] }),
    ...status({ steps: [{ text: "A", state: "doing" }] }),
    ...status({ steps: Array.from({ length: 8 }, (_, i) => ({ text: `Step ${i + 1}` })) }),
    ...status({ steps: two }),
    ...status({ steps: two, advance: true }),
    ...status({ advance: true, start: 2 }),
    ...status({ advance: true, done: [1] }),
    ...status({ done: [3] }),
    ...status({ start: 0 }),
    ...status({ start: 2 }),
    ...status({}),
  ]);
  await until(() => made.asked.length === 2, "the request after them");
  const said = outputs(made).map((output) =>
    output.startsWith('{"error"') ? refusal(output) : output,
  );
  assert.deepEqual(said, [
    "There are no steps yet: set them with `steps` first.",
    "There are no steps yet: set them with `steps` first.",
    "There are no steps yet: set them with `steps` first.",
    "At most 8 steps: this list has 9.",
    "At most one step may be in progress.",
    "Each step needs its text: words saying what it is.",
    "A step's state is pending, in_progress or completed.",
    Array.from({ length: 8 }, (_, i) => `${i + 1}. pending: Step ${i + 1}`).join("\n"),
    "1. in_progress: A\n2. pending: B",
    "Set the list with `steps`, or move through it with `advance`, `done` or `start`: not both in one call.",
    "Use `advance` alone, or `done` and `start`: not both in one call.",
    "Use `advance` alone, or `done` and `start`: not both in one call.",
    "There is no step 3: the steps are numbered 1 to 2.",
    "There is no step 0: the steps are numbered 1 to 2.",
    "Step 1 is in progress: complete it with `done` in the same call.",
    "Give `steps` to set the list, `advance` to go to the next step, or `done` and `start` by number.",
  ]);
  assert.deepEqual(await stepsOf(made.looper), [
    { text: "A", state: "in_progress" },
    { text: "B", state: "pending" },
  ]);
  made.answer("Plan the trip.", sends("Planned."));
  await made.looper.settled();
});

test("a field given as null is taken as absent", async () => {
  const made = looperWith();
  await made.looper.send("a", "Plan the trip.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Plan the trip.", [
    ...status({
      steps: [{ text: "A", active: null, state: null }, { text: "B" }],
      advance: null,
      done: null,
      start: null,
    }),
    ...status({ steps: null, done: null, start: 1 }),
    ...status({ steps: null, advance: true, start: null }),
  ]);
  await until(() => made.asked.length === 2, "the request after them");
  assert.deepEqual(outputs(made), [
    "1. pending: A\n2. pending: B",
    "1. in_progress: A\n2. pending: B",
    "1. completed: A\n2. in_progress: B",
  ]);
  made.answer("Plan the trip.", sends("Planned."));
  await made.looper.settled();
});

test("a status call that leaves the step's words as they were says nothing on the messages", async () => {
  const made = looperWith();
  await made.looper.send("a", "Plan the trip.");
  await until(() => made.asked.length === 1, "the request");
  made.answer(
    "Plan the trip.",
    status({ steps: [{ text: "A", state: "in_progress" }, { text: "B" }, { text: "C" }] }),
  );
  await until(() => made.asked.length === 2, "the request after it");
  const said = [...made.progress];
  assert.deepEqual(facts(made), ["a: Plan the trip. taken", "a: Plan the trip. taken: A"]);
  made.answer("Plan the trip.", status({ done: [2] }));
  await until(() => made.asked.length === 3, "the request after that");
  assert.equal(answered(made), "1. in_progress: A\n2. completed: B\n3. pending: C");
  assert.deepEqual(made.progress, said);
  made.answer("Plan the trip.", status({ steps: [{ text: "A", state: "in_progress" }] }));
  await until(() => made.asked.length === 4, "the request after a new list");
  assert.deepEqual(made.progress, said);
  made.answer("Plan the trip.", sends("Planned."));
  await made.looper.settled();
});

test("a later turn's message is not at a step an earlier turn left in progress, until this turn keeps its steps", async () => {
  const made = looperWith();
  await made.looper.send("a", "Plan the trip.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Plan the trip.", [
    ...status({ steps: [{ text: "Find flights", state: "in_progress" }] }),
    ...sends("On it."),
  ]);
  await made.looper.settled();
  // The turn ended at that step; the next one hasn't said where it stands.
  await made.looper.send("a", "What's the weather?");
  await until(() => made.asked.length === 2, "the next turn's request");
  await until(() => facts(made).length === 4, "it to be taken");
  assert.equal(facts(made).at(-1), "a: What's the weather? taken");
  // Its steps kept again, unchanged: what it reads next is at that step.
  made.answer(
    "What's the weather?",
    status({ steps: [{ text: "Find flights", state: "in_progress" }] }),
  );
  await until(() => made.asked.length === 3, "the request after it");
  await until(() => facts(made).length === 5, "the step to be said");
  assert.equal(facts(made).at(-1), "a: What's the weather? taken: Find flights");
  made.answer("What's the weather?", sends("Sunny."));
  await made.looper.settled();
});

test("a follow-up the main loop gives to work in a turn at a step is at that step once the work reads it", async () => {
  const made = looperWith({
    routing: (text) => (text === "Book a hotel too." ? routeTo("a") : newWork()),
  });
  await made.looper.send("a", "Plan the trip.");
  await until(() => made.asked.length === 1, "the request");
  made.answer(
    "Plan the trip.",
    status({ steps: [{ text: "Find flights", active: "Finding flights", state: "in_progress" }] }),
  );
  await until(() => made.asked.length === 2, "the request after it");
  await made.looper.send("b", "Book a hotel too.");
  // The main loop takes it, and gives it to the work, which holds it in its turn.
  await until(
    () => (made.values.get("thread/b/msg/000000000001") as { work?: string }).work === "a",
    "the work to take it",
  );
  assert.deepEqual(
    facts(made).filter((one) => one.startsWith("b: ")),
    ["b: Book a hotel too. taken"],
  );
  made.answer("Plan the trip.", []);
  await until(() => made.asked.length === 3, "the request that reads it");
  await until(() => facts(made).length === 4, "its step to be said");
  assert.equal(facts(made).at(-1), "b: Book a hotel too. taken: Finding flights");
  made.answer("Book a hotel too.", sends("Booked."));
  await made.looper.settled();
  assert.deepEqual(await page(made.looper, "b"), ["Book a hotel too. (answered)", "Booked."]);
});

test("kept across a restart: a looper made again on the same store gives the same steps", async () => {
  const first = looperWith();
  await first.looper.send("a", "Plan the trip.");
  await until(() => first.asked.length === 1, "the request");
  first.answer(
    "Plan the trip.",
    status({ steps: [{ text: "Find flights", active: "Finding flights", state: "in_progress" }] }),
  );
  await until(() => first.asked.length === 2, "the request after it");
  // Gone while the turn runs, before its end writes the work's record.
  await first.looper.close();
  const again = looperWith({ values: first.values });
  assert.deepEqual(await stepsOf(again.looper), [
    { text: "Find flights", active: "Finding flights", state: "in_progress" },
  ]);
});

/** A tool that reads a file: each output is 25,000 characters, so twenty are over the least room. */
const look: Tool = {
  name: "look",
  parameters: {},
  run: async () => ({ output: "x".repeat(25_000), ok: true }),
};
const looks = (count: number): OutputItem[] =>
  Array.from({ length: count }, (_, i) => ({
    type: "function_call",
    callId: `look-${i}`,
    name: "look",
    arguments: JSON.stringify({ path: `f${i}.ts` }),
  }));

test("after a compaction, the model is told its current steps with the summary", async () => {
  const made = looperWith({
    tools: [look],
    instructions: "x".repeat(REQUEST_BUDGET - INPUT_BUDGET),
  });
  await made.looper.send("a", "Read every file.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Read every file.", [
    ...status({ steps: [{ text: "Read the files", state: "in_progress" }, { text: "Sum up" }] }),
    ...looks(20),
  ]);
  await until(() => made.asked.length === 2, "the request after the calls");
  assert.equal(made.summaries.length, 1);
  const summary = (made.raw[1] ?? []).find(
    (item) => (item as { content?: string }).content?.startsWith(SUMMARY_BEGINS) === true,
  ) as { content: string } | undefined;
  assert.match(
    summary?.content ?? "",
    /<\/summary>\n\nYour steps at this point, kept with `status`:\n1\. in_progress: Read the files\n2\. pending: Sum up$/,
  );
  made.answer(made.asked[1] as string, sends("Read them all."));
  await made.looper.settled();
});

test("the step is said on each held, taken message, by its active words or its text, again as it changes, and kept on it for a page read later", async () => {
  const made = looperWith();
  await made.looper.send("a", "Plan the trip.");
  await until(() => made.asked.length === 1, "the request");
  made.answer(
    "Plan the trip.",
    status({
      steps: [
        { text: "Find flights", active: "Finding flights", state: "in_progress" },
        { text: "Book a hotel" },
      ],
    }),
  );
  await until(() => made.asked.length === 2, "the request after it");
  assert.deepEqual(facts(made), [
    "a: Plan the trip. taken",
    "a: Plan the trip. taken: Finding flights",
  ]);
  // A message said meanwhile is not taken yet, and is at no step until it is.
  await made.looper.send("a", "Also a car.");
  made.answer(
    "Plan the trip.",
    status({
      steps: [
        { text: "Find flights", active: "Comparing flights", state: "in_progress" },
        { text: "Book a hotel" },
      ],
    }),
  );
  await until(() => made.asked.length === 3, "the request that reads it");
  assert.deepEqual(facts(made).slice(2), [
    "a: Plan the trip. taken: Comparing flights",
    "a: Also a car. taken: Comparing flights",
  ]);
  // Answered, a message is at no step; the one still taken is at the next, by its text.
  made.answer("Also a car.", [...sends("Flights found.", 1), ...status({ advance: true })]);
  await until(() => made.asked.length === 4, "the request after them");
  assert.deepEqual(facts(made).slice(4), [
    "a: Plan the trip. answered",
    "a: Also a car. taken: Book a hotel",
  ]);
  const shown = [
    "Plan the trip. (answered)",
    "Also a car. (taken: Book a hotel)",
    "Flights found.",
  ];
  assert.deepEqual(await page(made.looper, "a"), shown);
  assert.deepEqual(await page(looperWith({ values: made.values }).looper, "a"), shown);
  // With none in progress, it is at none; closed, it keeps none.
  made.answer("Also a car.", status({ advance: true }));
  await until(() => made.asked.length === 5, "the request after it");
  made.answer("Also a car.", status({ steps: [{ text: "Rent a car", state: "in_progress" }] }));
  await until(() => made.asked.length === 6, "the request after that");
  made.answer("Also a car.", says("That's all for now."));
  await made.looper.settled();
  assert.deepEqual(facts(made).slice(6), [
    "a: Also a car. taken",
    "a: Also a car. taken: Rent a car",
    "a: Also a car. closed",
  ]);
  assert.deepEqual(await page(made.looper, "a"), [
    "Plan the trip. (answered)",
    "Also a car. (closed)",
    "Flights found.",
  ]);
});

test("a message two pieces of work hold is at the step either set last", async () => {
  const made = looperWith({
    routing: (text) => (text.startsWith(BACK) ? newWork("The weather") : newWork("The report")),
  });
  // Thread `a` followed by two pieces of work, each in a turn, both holding one message.
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the report's request");
  await made.looper.send("a", "What is the weather?");
  await until(() => made.mains.length === 2, "the main loop to hear of it");
  made.answer("Write the report.", []);
  await until(() => made.asked.length === 2, "the report's request that reads both");
  made.answer("What is the weather?", handsBack(numberIn(made.numbered, "report")));
  await until(() => made.asked.length === 4, "the report's turn to go on, and the weather's");
  const thanks = "Thanks, both.";
  await made.looper.send("a", thanks);
  made.answer("What is the weather?", sends("Report done."), "report");
  made.answer("What is the weather?", sends("Sunny."), "weather");
  await until(() => made.asked.length === 6, "both to read it");
  const stepOn = async () => (await page(made.looper, "a")).find((one) => one.startsWith(thanks));
  made.answer(thanks, status({ steps: [{ text: "Tidy up", state: "in_progress" }] }), "report");
  await until(() => made.asked.length === 7, "the report's next request");
  assert.equal(await stepOn(), `${thanks} (taken: Tidy up)`);
  made.answer(thanks, status({ steps: [{ text: "Check rain", state: "in_progress" }] }), "weather");
  await until(() => made.asked.length === 8, "the weather's next request");
  assert.equal(await stepOn(), `${thanks} (taken: Check rain)`);
  made.answer(thanks, status({ steps: [{ text: "Send it", state: "in_progress" }] }), "report");
  await until(() => made.asked.length === 9, "the report's request after that");
  assert.equal(await stepOn(), `${thanks} (taken: Send it)`);
  assert.deepEqual(
    facts(made).filter((one) => one.includes(thanks)),
    [
      `a: ${thanks} taken`,
      `a: ${thanks} taken: Tidy up`,
      `a: ${thanks} taken: Check rain`,
      `a: ${thanks} taken: Send it`,
    ],
  );
  made.answer(thanks, sends("You're welcome."), "report");
  made.answer(thanks, sends("Any time."), "weather");
  await made.looper.settled();
  assert.equal(await stepOn(), `${thanks} (answered)`);
});

test("a status call is no Activity entry, and the main loop isn't offered status", async () => {
  const done: Tool = {
    name: "note",
    parameters: {},
    run: async () => ({ output: "Noted.", ok: true }),
  };
  const made = looperWith({ tools: [done] });
  await made.looper.send("a", "Plan the trip.");
  await until(() => made.asked.length === 1, "the request");
  const names = (tools: unknown[] | undefined) =>
    (tools as { name: string }[]).map((one) => one.name);
  assert.deepEqual(names(made.mains[0]?.tools), ["route"]);
  assert.deepEqual(made.told[0]?.tools, ["note", "send", "hand_back", "status"]);
  made.answer("Plan the trip.", [
    ...status({ steps: [{ text: "Find flights" }] }),
    { type: "function_call", callId: "n1", name: "note", arguments: "{}" },
  ]);
  await until(() => made.asked.length === 2, "the request after them");
  // Kept for the model, as hand_back is.
  assert.deepEqual(made.inputs[1]?.slice(1), [
    "call status",
    "output 1. pending: Find flights",
    "call note",
    "output Noted.",
  ]);
  made.answer("Plan the trip.", sends("Planned."));
  await made.looper.settled();
  const { entries } = await made.looper.entries("a", undefined, 10);
  assert.deepEqual(
    entries.map((one: WorkEntry) => ("call" in one ? one.call.name : JSON.stringify(one))),
    ["note"],
  );
});

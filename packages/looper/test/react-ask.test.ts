import assert from "node:assert/strict";
import test from "node:test";
import type { OutputItem } from "../src/index.ts";
import { askOf, NO_REPLY, reactionOf, SEND } from "../src/loop.ts";
import { pickedOf } from "../src/looper.ts";
import { CLOSE } from "../src/main.ts";
import { looperWith, newWork, sends, until } from "./support.ts";

type Made = ReturnType<typeof looperWith>;

/** A worker's call of `function` with `args`. */
const calling = (name: string, args: unknown): OutputItem[] => [
  {
    type: "function_call",
    callId: `${name}-${crypto.randomUUID()}`,
    name,
    arguments: JSON.stringify(args),
  },
];
/** The number the message `text` had in the latest request that read it. */
const numberOf = (made: Made, text: string) => {
  const line = made.numbered
    .findLast((lines) => lines.some((one) => one.endsWith(`] ${text}`)))
    ?.find((one) => one.endsWith(`] ${text}`));
  return Number(/^\[(\d+)\]/.exec(line ?? "")?.[1]);
};
/** What the calls of the latest request gave back, as its next request was sent them. */
const lastOutput = (made: Made) =>
  (made.inputs.at(-1) ?? [])
    .findLast((line) => line.startsWith("output "))
    ?.slice("output ".length) ?? "";
const refusal = (output: string) =>
  (JSON.parse(output) as { error: { message: string } }).error.message;
const rested = async (made: Made) => {
  await until(() => made.working.at(-1) === false, "the turn to end");
  await made.looper.settled();
};
/** A thread's page as a page read now shows it. */
const page = async (made: Made, thread: string) =>
  (await made.looper.page(thread, undefined, 50)).messages;
/** Work in thread `a` that answered its first message, and has been thanked. */
async function thanked(options: Parameters<typeof looperWith>[0] = {}) {
  const made = looperWith(options);
  await made.looper.send("a", "Write the report.");
  await until(() => made.asked.length === 1, "the request");
  made.answer("Write the report.", sends("Done."));
  await rested(made);
  await made.looper.send("a", "Thanks!");
  await until(() => made.asked.length === 2, "the request that reads it");
  return made;
}

test("neither a reaction nor a card is offered to the model yet: send, no_reply_needed and the main loop's close are as they were", () => {
  for (const spec of [SEND, NO_REPLY, CLOSE]) {
    const offered = Object.keys((spec.parameters as { properties: object }).properties);
    for (const name of ["reaction", "choices", "questions"])
      assert.ok(!offered.includes(name), `${spec.name}: ${name}`);
  }
});

test("a worker's close with a reaction keeps it: said with the close, and on the message a page reads later", async () => {
  const made = await thanked();
  made.answer(
    "Thanks!",
    calling("no_reply_needed", { message: numberOf(made, "Thanks!"), reaction: "👍" }),
  );
  await rested(made);
  assert.equal(made.reactions.length, 1);
  assert.match(made.reactions[0] ?? "", /^a: \S+ 👍$/);
  const thanks = (await page(made, "a")).find(({ text }) => text === "Thanks!");
  assert.deepEqual(thanks?.progress, { state: "closed", reaction: "👍" });
  // A close with none keeps none.
  const plain = await thanked();
  plain.answer("Thanks!", calling("no_reply_needed", { message: numberOf(plain, "Thanks!") }));
  await rested(plain);
  assert.deepEqual(plain.reactions, []);
  assert.deepEqual((await page(plain, "a")).find(({ text }) => text === "Thanks!")?.progress, {
    state: "closed",
  });
});

test("a reaction that isn't one emoji is refused to the model, and the message isn't closed", async () => {
  const made = await thanked();
  made.answer(
    "Thanks!",
    calling("no_reply_needed", { message: numberOf(made, "Thanks!"), reaction: "ok" }),
  );
  await until(() => made.asked.length === 3, "the request after the refusal");
  assert.equal(refusal(lastOutput(made)), "A reaction is one emoji, such as 👍.");
  assert.deepEqual(made.reactions, []);
  assert.notEqual(
    (await page(made, "a")).find(({ text }) => text === "Thanks!")?.progress?.state,
    "closed",
  );
  made.answer("Thanks!", calling("no_reply_needed", { message: numberOf(made, "Thanks!") }));
  await rested(made);
});

test("a reaction is one emoji: one pictograph, a flag, or a sequence joined into one; two, or anything else, is none", () => {
  for (const one of ["👍", "❤️", "🇫🇷", "👍🏽", "👩‍💻"]) assert.equal(reactionOf(one), one);
  for (const none of ["ok", "", "👍 ok", "1", 3, undefined, null, "👍👍", "1©", "#©"])
    assert.equal(reactionOf(none), undefined);
});

test("the main loop's close keeps its reaction, and lets one that isn't an emoji go and closes all the same", async () => {
  for (const [reaction, kept] of [
    ["🙏", "🙏"],
    ["thanks", undefined],
  ] as const) {
    const made = looperWith({
      routing: (text) =>
        text === "Thanks!" ? calling("no_reply_needed", { reaction }) : newWork(),
    });
    await made.looper.send("a", "Thanks!");
    await rested(made);
    assert.deepEqual(made.said, ["a: user: Thanks!"]);
    const thanks = (await page(made, "a")).find(({ text }) => text === "Thanks!");
    assert.deepEqual(thanks?.progress, { state: "closed", ...(kept ? { reaction: kept } : {}) });
    assert.equal(made.reactions.length, kept ? 1 : 0);
  }
});

const choices = [{ label: "Yes, delete it" }, { label: "No, keep it", detail: "Nothing changes." }];
/** Work in thread `a` whose reply to its first message carries `card`, as `send` gives one. */
async function carded(card: Record<string, unknown>) {
  const made = looperWith({});
  await made.looper.send("a", "Clean the folder.");
  await until(() => made.asked.length === 1, "the request");
  made.answer(
    "Clean the folder.",
    calling("send", { message: numberOf(made, "Clean the folder."), text: "Delete all?", ...card }),
  );
  await rested(made);
  const reply = made.messages.find(({ text }) => text === "Delete all?");
  return { made, reply };
}

test("a send with a card keeps it on its reply: said with it, and read later", async () => {
  const { made, reply } = await carded({ choices: [" Yes, delete it ", choices[1]] });
  const ask = { questions: [{ choices }] };
  assert.deepEqual(reply?.ask, ask);
  assert.deepEqual((await page(made, "a")).find(({ text }) => text === "Delete all?")?.ask, ask);
  // Several questions, each named, any of them taking several picks.
  const tabs = {
    questions: [
      { header: "Size", choices: ["Small", "Large"] },
      { header: "Extras", choices: ["Lid", "Sleeve"], many: true },
    ],
  };
  assert.deepEqual((await carded(tabs)).reply?.ask, {
    questions: [
      { header: "Size", choices: [{ label: "Small" }, { label: "Large" }] },
      { header: "Extras", choices: [{ label: "Lid" }, { label: "Sleeve" }], many: true },
    ],
  });
  // A send with none has none.
  const plain = looperWith({});
  await plain.looper.send("a", "Draft the email.");
  await until(() => plain.asked.length === 1, "the request");
  plain.answer("Draft the email.", sends("Here it is."));
  await rested(plain);
  assert.equal("ask" in (plain.messages.find(({ text }) => text === "Here it is.") ?? {}), false);
});

test("a card that breaks what a card holds is let go: the reply is sent without it, as what it says may already show", async () => {
  for (const card of [
    { choices: [] },
    { choices: ["a", "b", "c", "d", "e"] },
    { choices: ["x".repeat(49)] },
    { choices: [{ label: "Yes", detail: "x".repeat(121) }] },
    { questions: [{ header: "Only", choices: ["Yes"] }] },
    { questions: [{ choices: ["Yes"] }, { header: "B", choices: ["No"] }] },
    { choices: ["Yes"], questions: [] },
    { choices: "Yes" },
  ]) {
    const { made, reply } = await carded(card);
    assert.equal(made.asked.length, 1, "nothing was refused");
    assert.ok(reply, JSON.stringify(card));
    assert.equal("ask" in (reply ?? {}), false, JSON.stringify(card));
  }
  assert.equal(askOf({}), undefined);
  // What a model gives for nothing is nothing: null, and words that may be left out, left empty.
  assert.equal(askOf({ choices: null, questions: null }), undefined);
  assert.deepEqual(
    askOf({ choices: [{ label: "Yes", detail: " " }], question: "", questions: null }),
    { questions: [{ choices: [{ label: "Yes" }] }] },
  );
  assert.equal(askOf({ choices: [{ label: " " }] }), false);
  // A confirm beside several picks says nothing: it is dropped.
  assert.deepEqual(askOf({ choices: ["A", "B"], many: true, confirm: true }), {
    questions: [{ choices: [{ label: "A" }, { label: "B" }], many: true }],
  });
  assert.deepEqual(askOf({ choices: ["A"], confirm: true }), {
    questions: [{ choices: [{ label: "A" }] }],
    confirm: true,
  });
});

test("a card's answer is said as the person's message, with what was picked as its words, and keeps the answer", async () => {
  const { made, reply } = await carded({ choices });
  const to = reply?.id as string;
  await made.looper.answer("a", { to, picks: [[1]] });
  await until(() => made.asked.length === 2, "the request that reads it");
  const answered = made.messages.find(
    ({ role, text }) => role === "user" && text === "No, keep it",
  );
  assert.deepEqual(answered?.answer, { to, picks: [[1]] });
  assert.deepEqual((await page(made, "a")).find(({ id }) => id === answered?.id)?.answer, {
    to,
    picks: [[1]],
  });
  // Answered, the card isn't open: a second answer is refused, and says nothing.
  await assert.rejects(made.looper.answer("a", { to, picks: [[0]] }), { code: "state" });
  // An answer to what carries no card is refused too.
  await assert.rejects(made.looper.answer("a", { to: "none", picks: [[0]] }), { code: "state" });
});

test("a card is open only until the person writes after it: then it is passed over, and an answer to it is refused", async () => {
  const { made, reply } = await carded({ choices });
  await made.looper.send("a", "Actually, leave it for now.");
  await until(() => made.asked.length === 2, "the request that reads it");
  await assert.rejects(made.looper.answer("a", { to: reply?.id as string, picks: [[0]] }), {
    code: "state",
  });
});

test("picks must fit their card: one for each question, choices it has, once each, and one unless it takes many", () => {
  const card = {
    questions: [
      { header: "Size", choices: [{ label: "Small" }, { label: "Large" }] },
      { header: "Extras", choices: [{ label: "Lid" }, { label: "Sleeve" }], many: true as const },
    ],
  };
  assert.equal(pickedOf(card, [[1], [0, 1]]), "Size: Large\nExtras: Lid, Sleeve");
  assert.equal(pickedOf({ questions: [card.questions[1] as never] }, [[1, 0]]), "Sleeve, Lid");
  for (const picks of [[[1]], [[0, 1], [0]], [[2], [0]], [[0], [1, 1]], [[], [0]], [[0], [0], [0]]])
    assert.throws(() => pickedOf(card, picks), { code: "invalid" }, JSON.stringify(picks));
});

test("a reaction the store refuses to keep goes back with its close: the message shows neither, and none is said", async () => {
  // "Thanks!" is the thread's third message, and the close's own line its fourth.
  let closing = false;
  let refused = false;
  const made = await thanked({
    writing: (key) => {
      if (key === "thread/a/msg/000000000004") closing = true;
      else if (closing && !refused && key === "thread/a/msg/000000000003") {
        refused = true;
        return Promise.reject(new Error("the store refused it"));
      }
      return undefined;
    },
  });
  made.answer(
    "Thanks!",
    calling("no_reply_needed", { message: numberOf(made, "Thanks!"), reaction: "👍" }),
  );
  await rested(made);
  assert.ok(refused);
  assert.deepEqual(made.reactions, []);
  const thanks = (await page(made, "a")).find(({ text }) => text === "Thanks!");
  assert.equal(thanks?.progress?.reaction, undefined);
  assert.notEqual(thanks?.progress?.state, "closed");
});

test("a close given no reaction, null as much as none, closes with none and refuses nothing", async () => {
  const made = await thanked();
  made.answer(
    "Thanks!",
    calling("no_reply_needed", { message: numberOf(made, "Thanks!"), reaction: null }),
  );
  await rested(made);
  assert.equal(made.asked.length, 2, "nothing was refused");
  assert.deepEqual(made.reactions, []);
  assert.deepEqual((await page(made, "a")).find(({ text }) => text === "Thanks!")?.progress, {
    state: "closed",
  });
});

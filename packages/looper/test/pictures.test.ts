import assert from "node:assert/strict";
import test from "node:test";
import type { Item, Json, Picture, Tool } from "../src/index.ts";
import { gate, idle, looperWith, says, sends, until } from "./support.ts";

const picture = (name: string): Picture => ({ mediaType: "image/png", data: name });
/** The pictures among `items`, by their data, and the words said where one was left out. */
const seen = (items: unknown[]) =>
  (items as Item[]).flatMap((item) => [
    ...(item.type !== "function_call" ? (item.images ?? []).map(({ data }) => data) : []),
    ...((item.type === "message"
      ? item.content
      : item.type === "function_call_output"
        ? item.output
        : ""
    ).match(/\(A picture, left out\.\)/g) ?? []),
  ]);
/** A tool that gives a picture with its text. */
const look: Tool = {
  name: "look",
  parameters: {},
  run: async () => ({ output: "A screen.", ok: true, images: [picture("screen")] }),
};
const looks = [{ type: "function_call" as const, callId: "c1", name: "look", arguments: "{}" }];

test("a person's picture reaches the work's model with the message, and a tool's with its call's output for the turn under way only", async () => {
  const { looper, asked, raw, answer, messages } = looperWith({ tools: [look] });
  await looper.send("a", "Look at this.", [picture("person")]);
  await until(() => asked.length === 1, "the request");
  assert.deepEqual(seen(raw[0] ?? []), ["person"]);
  // The person's message is said with its picture.
  assert.deepEqual(
    [messages[0]?.text, messages[0]?.images?.map(({ data }) => data)],
    ["Look at this.", ["person"]],
  );
  answer("Look at this.", looks);
  await until(() => asked.length === 2, "the request after the call");
  assert.deepEqual(seen(raw[1] ?? []), ["person", "screen"]);
  answer("Look at this.", sends("A login screen."));
  await looper.settled();
  // The next turn: the person's picture still, the call's said as left out.
  await looper.send("a", "And now?");
  await until(() => asked.length === 3, "the next turn's request");
  assert.deepEqual(seen(raw[2] ?? []), ["person", "(A picture, left out.)"]);
  answer("And now?", sends("The same."));
  await looper.settled();
  const { messages: page } = await looper.page("a", undefined, 10);
  assert.deepEqual(
    page.map(({ text, images }) => [text, images?.map(({ data }) => data) ?? []]),
    [
      ["Look at this.", ["person"]],
      ["A login screen.", []],
      ["And now?", []],
      ["The same.", []],
    ],
  );
});

/** A tool that gives a picture of 300,000 characters each time, named by its count. */
function shooter() {
  let shots = 0;
  const tool: Tool = {
    name: "shoot",
    parameters: {},
    run: async () => {
      shots++;
      return {
        output: `Shot ${shots}.`,
        ok: true,
        images: [picture(`s${shots}`.padEnd(300_000, "A"))],
      };
    },
  };
  const call = (callId: string) => [
    { type: "function_call" as const, callId, name: "shoot", arguments: "{}" },
  ];
  /** What its calls' outputs keep in the store: each one's words and how many pictures. */
  const kept = (values: Map<string, Json>) =>
    [...values]
      .filter(([key]) => key.startsWith("thread/a/msg/"))
      .flatMap(([, value]) => (value as { items: Item[] }).items)
      .flatMap((item) =>
        item.type === "function_call_output" && item.output.startsWith("Shot")
          ? [[item.output, item.images?.length ?? 0]]
          : [],
      );
  return { tool, call, kept };
}
const GONE = "Shot 1.\n(A picture, left out.)";

test("a call's pictures are kept while a request can give them: until newer ones fill the budget, and no longer than their turn", async () => {
  const { tool, call, kept } = shooter();
  const { looper, asked, raw, answer, values } = looperWith({ tools: [tool] });
  await looper.send("a", "Shoot twice.");
  await until(() => asked.length === 1, "the request");
  answer("Shoot twice.", call("c1"));
  await until(() => asked.length === 2, "the request after one");
  answer("Shoot twice.", call("c2"));
  await until(() => asked.length === 3, "the request after two");
  // Two don't fit together: the newest is given, and the other is no longer kept.
  assert.deepEqual(
    seen(raw[2] ?? []).map((one) => one.slice(0, 2)),
    ["(A", "s2"],
  );
  assert.deepEqual(kept(values), [
    [GONE, 0],
    ["Shot 2.", 1],
  ]);
  answer("Shoot twice.", sends("Done."));
  await looper.settled();
  assert.deepEqual(kept(values), [
    [GONE, 0],
    ["Shot 2.\n(A picture, left out.)", 0],
  ]);
});

test("a turn that fails leaves its calls' pictures out, and a message said meanwhile starts another turn", async () => {
  const { tool, call, kept } = shooter();
  const { shut, open } = gate();
  let holding = false;
  const { looper, asked, answer, fail, values } = looperWith({
    tools: [tool],
    // What is written again after the failure waits, so a message is said while it does.
    writing: (key) => (holding && values.has(key) ? shut : undefined),
  });
  await looper.send("a", "Shoot.");
  await until(() => asked.length === 1, "the request");
  answer("Shoot.", call("c1"));
  await until(() => asked.length === 2, "the request after it");
  holding = true;
  fail("Shoot.");
  await idle();
  const sending = looper.send("a", "Again.");
  await idle();
  holding = false;
  open();
  await sending;
  await until(() => asked.length === 3, "the next turn's request");
  assert.equal(asked[2], "Again.");
  answer("Again.", sends("Done."));
  await looper.settled();
  assert.deepEqual(kept(values), [[GONE, 0]]);
});

test("a turn stopped while the model answers has its calls' pictures left out before the stop is done", async () => {
  const { tool, call, kept } = shooter();
  const { looper, asked, answer, values } = looperWith({ tools: [tool] });
  await looper.send("a", "Shoot.");
  await until(() => asked.length === 1, "the request");
  answer("Shoot.", call("c1"));
  await until(() => asked.length === 2, "the request after it");
  await looper.stop();
  assert.deepEqual(kept(values), [[GONE, 0]]);
});

test("a turn cut off by a restart keeps its calls' pictures, and the turn that goes on leaves them out at its end", async () => {
  const { tool, call, kept } = shooter();
  const first = looperWith({ tools: [tool] });
  await first.looper.send("a", "Shoot.");
  await until(() => first.asked.length === 1, "the request");
  first.answer("Shoot.", call("c1"));
  await until(() => first.asked.length === 2, "the request after it");
  await first.looper.close();
  await first.looper.settled();
  assert.deepEqual(kept(first.values), [["Shot 1.", 1]]);
  const second = looperWith({ tools: [tool], values: first.values });
  await second.looper.resume();
  await until(() => second.asked.length === 1, "the turn to go on");
  assert.deepEqual(
    seen(second.raw[0] ?? []).map((one) => one.slice(0, 2)),
    ["s1"],
  );
  second.answer(second.asked[0] as string, sends("Done."));
  await second.looper.settled();
  assert.deepEqual(kept(second.values), [[GONE, 0]]);
});

test("the main loop is given the person's pictures with what it decides on", async () => {
  const { looper, mainRaw, said } = looperWith({ routing: () => says("A cat.") });
  await looper.send("a", "What is this?", [picture("cat")]);
  await until(() => said.length === 2, "the answer");
  assert.deepEqual(seen(mainRaw[0] ?? []), ["cat"]);
});

test("a request whose instructions and tools leave no room for pictures says each one left out", async () => {
  const wide: Tool = {
    name: "wide",
    description: "x".repeat(1_000_000),
    parameters: {},
    run: async () => ({ output: "", ok: true }),
  };
  const { looper, asked, raw, answer } = looperWith({ tools: [wide] });
  await looper.send("a", "Look at this.", [picture("person")]);
  await until(() => asked.length === 1, "the request");
  assert.deepEqual(seen(raw[0] ?? []), ["(A picture, left out.)"]);
  answer("Look at this.\n(A picture, left out.)", sends("Can't see it."));
  await looper.settled();
});

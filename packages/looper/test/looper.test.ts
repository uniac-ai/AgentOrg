import assert from "node:assert/strict";
import test from "node:test";
import {
  createLooper,
  type Json,
  type OutputItem,
  Refusal,
  type Shown,
  type Tool,
} from "../src/index.ts";
import { newWork } from "./support.ts";

/**
 * A looper on a store in memory, a model that answers from `replies`, and what it said. The store
 * lists two keys at a time, so anything long is read over several pages.
 */
function looperWith(
  replies: (OutputItem[] | Error | Promise<OutputItem[]>)[],
  tools: Tool[] = [],
  values = new Map<string, Json>(),
) {
  const said: { thread: string; message: Shown }[] = [];
  /** Each time it said whether anything is at work, and each message that got no answer. */
  const working: boolean[] = [];
  const failures: { thread: string; problem: { code: string; message: string } }[] = [];
  const deltas: { thread: string; id: string; text: string }[] = [];
  const requests: { requestId: string; instructions: string; input: unknown[]; tools: unknown }[] =
    [];
  const looper = createLooper({
    store: {
      get: async ({ key }) => (values.has(key) ? { value: values.get(key) as Json } : {}),
      set: async ({ key, value }) => void values.set(key, value),
      delete: async ({ key }) => void values.delete(key),
      async list({ prefix = "", after }) {
        const rest = [...values.keys()]
          .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
          .sort();
        const keys = rest.slice(0, 2);
        return { keys, next: rest.length > 2 ? (keys[1] as string) : null };
      },
    },
    model: {
      async respond(request) {
        // The main loop is answered at once, with new work; `requests` are the workers'.
        if (request.tools.some((tool) => tool.name === "route")) return { output: newWork() };
        requests.push(structuredClone(request));
        const reply = await (replies.shift() ?? []);
        if (reply instanceof Error) throw reply;
        return { output: reply };
      },
      cancel: async () => ({}),
    },
    request: async () => ({ instructions: "Be brief.", tools }),
    out: {
      message: (thread, message) => said.push({ thread, message }),
      delta: (thread, id, text) => deltas.push({ thread, id, text }),
      working: (on) => void working.push(on),
      failed: (thread, problem) => void failures.push({ thread, problem }),
    },
    log: { info() {}, warn() {}, error() {} },
  });
  return { looper, values, said, working, failures, deltas, requests };
}
const says = (content: string): OutputItem[] => [{ type: "message", role: "assistant", content }];
const calls = (name: string, args: string): OutputItem[] => [
  { type: "function_call", callId: `call-${name}`, name, arguments: args },
];

test("a message is answered in its thread, through the tools it was given, on that thread's record", async () => {
  const ran: unknown[] = [];
  const tools: Tool[] = [
    {
      name: "look",
      parameters: { type: "object" },
      run: async (input) => {
        ran.push(input);
        return { output: "seen", ok: true };
      },
    },
  ];
  const { looper, values, said, working, requests } = looperWith(
    [calls("look", '{"at":"it"}'), says("It is there."), says("Elsewhere.")],
    tools,
  );
  const { messageId } = await looper.send("one", "Look at it.");
  await looper.settled();
  await looper.send("two", "And you?");
  await looper.settled();
  assert.deepEqual(requests[0]?.tools, [{ name: "look", parameters: { type: "object" } }]);

  assert.deepEqual(ran, [{ at: "it" }]);
  assert.deepEqual(
    said.map(({ thread, message }) => [thread, message.role, message.text, message.tool?.state]),
    [
      ["one", "user", "Look at it.", undefined],
      ["one", "tool", "look: running", "running"],
      ["one", "tool", "look: done", "done"],
      ["one", "assistant", "It is there.", undefined],
      ["two", "user", "And you?", undefined],
      ["two", "assistant", "Elsewhere.", undefined],
    ],
  );
  assert.equal(said[0]?.message.id, messageId);
  // At work from each message until its answer, said once each way.
  assert.deepEqual(working, [true, false, true, false]);
  // Each thread's record is its own: the second request of the first holds the call and its
  // output, and the other thread's request holds none of it.
  assert.deepEqual(
    requests.map(({ input }) => input.length),
    [1, 3, 1],
  );
  assert.equal(requests[2]?.instructions, "Be brief.");
  assert.deepEqual(
    [...values.keys()]
      .filter((key) => key.startsWith("thread/"))
      .map((key) => key.replace(/\d+$/, "")),
    [...Array(3).fill("thread/one/msg/"), ...Array(2).fill("thread/two/msg/")],
  );
  assert.deepEqual(
    (await looper.page("one", undefined, 10)).messages.map((message) => message.role),
    ["user", "tool", "assistant"],
  );
  assert.deepEqual(looper.state("one"), { state: "idle" });
  assert.deepEqual(looper.state("a thread nothing was said in"), { state: "idle" });

  // A looper made again on the same store has each thread's record, and goes on from it.
  const again = looperWith([says("Still there.")], tools, values);
  assert.deepEqual(
    (await again.looper.page("one", undefined, 10)).messages.map((message) => message.text),
    ["Look at it.", "look: done", "It is there."],
  );
  await again.looper.send("one", "And now?");
  await again.looper.settled();
  assert.equal(again.requests[0]?.input.length, 5);
});

test("a thread's name can be anything: its keys hold it as one part, as its work's do", async () => {
  const { looper, values } = looperWith([says("Yes.")]);
  await looper.send("a/b c", "Hello?");
  await looper.settled();
  assert.deepEqual([...values.keys()].filter((key) => !key.startsWith("main/")).sort(), [
    "thread/a%2Fb%20c/msg/000000000001",
    "thread/a%2Fb%20c/msg/000000000002",
    "work/a%2Fb%20c",
  ]);
});

test("a refusal is shown with its code, and anything else thrown as `failed`", async () => {
  const tools: Tool[] = [
    {
      name: "refuses",
      parameters: {},
      run: async () => {
        throw new Refusal("not_connected", "It is not connected.");
      },
    },
    {
      name: "breaks",
      parameters: {},
      run: async () => {
        throw new Error("a secret detail");
      },
    },
  ];
  const { looper, said, failures } = looperWith(
    [
      [...calls("refuses", ""), ...calls("breaks", "")],
      new Refusal("usage_limit", "The limit is reached."),
      new Error("another detail"),
    ],
    tools,
  );
  await looper.send("one", "Go.");
  await looper.settled();
  assert.deepEqual(
    said.flatMap(({ message }) => (message.tool?.state === "refused" ? [message.tool.output] : [])),
    [
      '{"error":{"code":"not_connected","message":"It is not connected."}}',
      '{"error":{"code":"failed","message":"The call failed."}}',
    ],
  );
  assert.deepEqual(failures.at(-1), {
    thread: "one",
    problem: { code: "usage_limit", message: "The limit is reached." },
  });
  // A message after a failure starts a turn like any other.
  await looper.send("one", "Go on.");
  await looper.settled();
  assert.deepEqual(failures.at(-1), {
    thread: "one",
    problem: { code: "failed", message: "The call failed." },
  });
});

test("a model's streamed text goes to the reply it becomes", async () => {
  let answer: (output: OutputItem[]) => void = () => {};
  const reply = new Promise<OutputItem[]>((resolve) => {
    answer = resolve;
  });
  const { looper, said, deltas, requests } = looperWith([reply]);
  await looper.send("one", "First.");
  while (requests.length === 0) await new Promise((soon) => setImmediate(soon));
  assert.deepEqual(looper.state("one"), { state: "thinking" });

  looper.delta(requests[0]?.requestId as string, "Do");
  looper.delta("a request nobody made", "lost");
  answer(says("Done."));
  await looper.settled();
  const done = said.find(({ message }) => message.text === "Done.");
  assert.deepEqual(deltas, [{ thread: "one", id: done?.message.id, text: "Do" }]);
});

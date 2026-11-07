import assert from "node:assert/strict";
import test from "node:test";
import { hubActors, installer, layout } from "@agentorg/interfaces";
import { describeInterface, OutcomeUnknown, Refused } from "@agentorg/sdk";
import { createTestContext } from "@agentorg/sdk/testing";
import { INPUT_BUDGET } from "../src/history.ts";
import logic, { BASE_INSTRUCTIONS, INSTRUCTIONS } from "../src/logic.ts";
import { MAX_OUTPUT } from "../src/tools.ts";

type Item = { type: string; [key: string]: unknown };
type Request = {
  requestId: string;
  instructions: string;
  input: Item[];
  tools?: { name: string; parameters: unknown }[];
};
type Reply = { output: Record<string, unknown>[] };
type Step = Reply | ((request: Request) => Reply | Promise<Reply>);
const say = (content: string): Reply => ({
  output: [{ type: "message", role: "assistant", content }],
});
const callTool = (name: string, args: unknown, callId: string = crypto.randomUUID()) => ({
  type: "function_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});
const calls = (...items: ReturnType<typeof callTool>[]): Reply => ({ output: items });
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Wait for a condition, failing rather than hanging when it never comes. */
async function until(condition: () => boolean, what = "the condition") {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** A promise and the function that resolves it. */
function gate<T = void>() {
  let open: (value: T) => void = () => {};
  const shut = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { shut, open };
}

/** An in-memory kv@1 store's handlers. */
/** Values over storage's limit are refused as storage refuses them. */
const VALUE_LIMIT = 256 * 1024;
function memory(values = new Map<string, unknown>()) {
  const writes = { count: 0 };
  return {
    values,
    writes,
    handlers: {
      get: ({ key }: { key: string }) =>
        values.has(key) ? { value: values.get(key) as never } : {},
      set: ({ key, value }: { key: string; value: unknown }) => {
        if (bytes(JSON.stringify(value)) > VALUE_LIMIT) throw new Refused("quota", "too large");
        writes.count++;
        values.set(key, value);
        return {};
      },
      delete: ({ key }: { key: string }) => ({ deleted: values.delete(key) }),
      list: ({
        prefix = "",
        after,
        limit = 1000,
      }: {
        prefix?: string;
        after?: string;
        limit?: number;
      }) => {
        const keys = [...values.keys()]
          .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
          .sort()
          .slice(0, limit);
        return { keys, next: keys.length === limit ? (keys.at(-1) ?? null) : null };
      },
    },
  };
}

/** The assistant with an in-memory store and a scripted model. */
async function setup(values = new Map<string, unknown>()) {
  const actor = createTestContext(logic, { actorId: "assistant", module: "logic" });
  await actor.start();
  const store = memory(values);
  actor.bind("store", store.handlers);
  const requests: Request[] = [];
  const cancels: string[] = [];
  const script: Step[] = [];
  const model = actor.bind("model", {
    respond: async (request) => {
      requests.push(request as Request);
      const next = script.shift() ?? say("ok");
      return (typeof next === "function" ? await next(request as Request) : next) as never;
    },
    cancel: ({ requestId }) => {
      cancels.push(requestId);
      return {};
    },
  });
  const statuses = (from = 0) =>
    actor.emitted
      .slice(from)
      .filter((e) => e.event === "status")
      .map((e) => e.payload as { state: string; detail?: { code: string; message: string } });
  /** Wait for the turn begun at `from` to end: its first idle or error status. */
  const ended = async (from: number) => {
    let end: ReturnType<typeof statuses>[number] | undefined;
    await until(() => {
      end = statuses(from).find((s) => s.state === "idle" || s.state === "error");
      return end !== undefined;
    }, "the turn to end");
    return end as NonNullable<typeof end>;
  };
  const turn = async (text: string) => {
    const from = actor.emitted.length;
    await actor.call("chat", "send", { text });
    return ended(from);
  };
  const messages = () =>
    actor.emitted
      .filter((e) => e.event === "message")
      .map((e) => {
        const { role, text } = e.payload as { role: string; text: string };
        return `${role}: ${text}`;
      });
  return { actor, store, requests, cancels, script, model, turn, ended, statuses, messages };
}

test("the tools are the bound slots' methods, apart from model and store", async () => {
  const s = await setup();
  await s.turn("hello");
  assert.deepEqual(s.requests[0]?.tools, []);
  s.actor.bind("layout", { place: () => ({ id: "p1" }) });
  await s.turn("again");
  const offered = s.requests[1]?.tools ?? [];
  assert.deepEqual(
    offered.map((tool) => tool.name),
    ["layout__get", "layout__place", "layout__remove", "layout__move"],
  );
  const place = describeInterface(layout);
  assert.ok(place.kind === "rpc");
  assert.deepEqual(
    offered.find((tool) => tool.name === "layout__place")?.parameters,
    place.methods.place?.input,
  );
  s.actor.bind("actors", { list: () => ({ actors: [] }) });
  s.actor.unbind("layout");
  await s.turn("and again");
  assert.deepEqual(
    (s.requests[2]?.tools ?? []).map((tool) => tool.name),
    Object.keys(hubActors.methods).map((method) => `actors__${method}`),
  );
});

test("bound to an installer, the agent can plan and install what it builds", async () => {
  const s = await setup();
  await s.turn("hello");
  s.actor.bind("installer", { plan: () => ({ slots: [], views: [] }) });
  await s.turn("make me a counter");
  // How to make an Actor is told only once it can build one too.
  s.actor.bind("packages", { list: () => ({ packages: [] }) });
  await s.turn("now");
  assert.deepEqual(
    s.requests.map((r) => r.instructions),
    [BASE_INSTRUCTIONS, BASE_INSTRUCTIONS, INSTRUCTIONS],
  );
  const offered = s.requests[1]?.tools ?? [];
  assert.deepEqual(
    offered.map((tool) => tool.name),
    Object.keys(installer.methods).map((method) => `installer__${method}`),
  );
  const described = describeInterface(installer);
  assert.ok(described.kind === "rpc");
  assert.deepEqual(
    offered.find((tool) => tool.name === "installer__install")?.parameters,
    described.methods.install?.input,
  );
});

test("a function call runs through its slot, and its result or refusal goes back", async () => {
  const s = await setup();
  const placed: unknown[] = [];
  s.actor.bind("layout", {
    place: (input) => {
      placed.push(input);
      if (input.module === "logic") throw new Refused("invalid", "logic isn't a view module.");
      return { id: "p1" };
    },
    get: () => {
      throw new OutcomeUnknown();
    },
  });
  s.script.push(
    {
      output: [
        { type: "message", role: "assistant", content: "Placing it." },
        callTool("layout__place", { actor: "board", module: "panel" }, "c1"),
        callTool("layout__place", { actor: "board", module: "logic" }, "c2"),
      ],
    },
    calls(
      callTool("actors__list", {}, "c3"),
      { type: "function_call", callId: "c4", name: "layout__get", arguments: "{oops" },
      callTool("layout__get", {}, "c5"),
    ),
    (request) => {
      // The slot goes away between the tool list and the call.
      s.actor.unbind("layout");
      return calls({ ...callTool("layout__remove", { id: "p1" }, "c6") });
    },
    say("Placed the board."),
  );
  assert.deepEqual(await s.turn("Show me the board."), { state: "idle" });
  assert.deepEqual(placed, [
    { actor: "board", module: "panel" },
    { actor: "board", module: "logic" },
  ]);
  const last = s.requests.at(-1)?.input ?? [];
  const outputs = Object.fromEntries(
    last
      .filter((item) => item.type === "function_call_output")
      .map((item) => [item.callId, JSON.parse(item.output as string)]),
  );
  assert.deepEqual(outputs.c1, { id: "p1" });
  assert.deepEqual(
    ["c2", "c3", "c4", "c5", "c6"].map((id) => outputs[id].error.code),
    ["invalid", "unknown_tool", "invalid", "outcome_unknown", "not_connected"],
  );
  assert.deepEqual(s.messages(), [
    "user: Show me the board.",
    "assistant: Placing it.",
    "tool: layout__place: done",
    "tool: layout__place: invalid",
    "tool: actors__list: unknown_tool",
    "tool: layout__get: invalid",
    "tool: layout__get: outcome_unknown",
    "tool: layout__remove: not_connected",
    "assistant: Placed the board.",
  ]);
  // Every call in the history has its output, right after it, as the Responses API needs.
  for (const [i, item] of last.entries())
    if (item.type === "function_call") assert.equal(last[i + 1]?.callId, item.callId);
});

test("a turn makes at most 20 tool calls, and says so as its error", async () => {
  const s = await setup();
  let runs = 0;
  s.actor.bind("layout", {
    get: () => {
      runs++;
      return { home: [] };
    },
  });
  for (let i = 0; i < 30; i++) s.script.push(calls(callTool("layout__get", {})));
  const from = s.actor.emitted.length;
  assert.equal((await s.turn("Loop.")).detail?.code, "limit");
  assert.equal(runs, 20);
  assert.equal(s.requests.length, 20);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.statuses(from).at(-1)?.state, "error", "no idle after the limit");
  // Many calls in one reply: those past the limit are answered "limit", so every call is paired.
  s.script.length = 0;
  s.script.push(
    calls(...Array.from({ length: 25 }, (_, i) => callTool("layout__get", {}, `m${i}`))),
  );
  runs = 0;
  assert.equal((await s.turn("Many.")).detail?.code, "limit");
  assert.equal(runs, 20);
  assert.equal(s.messages().filter((m) => m === "tool: 5 calls: limit").length, 1);
});

test("cancel stops the model's response, and the next turn can start at once", async () => {
  const s = await setup();
  const late = gate();
  // As the model Actor does, the cancelled response is refused `cancelled`.
  s.script.push(() =>
    late.shut.then(() => {
      throw new Refused("cancelled", "The response was cancelled.");
    }),
  );
  const from = s.actor.emitted.length;
  await s.actor.call("chat", "send", { text: "Think long." });
  await until(() => s.requests.length === 1, "the model request");
  await s.actor.call("chat", "cancel", {});
  assert.deepEqual(s.cancels, [s.requests[0]?.requestId]);
  assert.deepEqual(s.statuses(from).at(-1), { state: "idle" });
  // Not busy: a new turn starts while the old reply is still out.
  await s.turn("Next.");
  late.open();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.messages(), ["user: Think long.", "user: Next.", "assistant: ok"]);
  // A cancel isn't a failure.
  assert.equal(s.actor.logs.filter((line) => line.message === "A turn failed.").length, 0);
});

test("a cancel before the model is asked means it is never asked", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  const saved = gate();
  const store = memory(values);
  s.actor.bind("store", {
    ...store.handlers,
    set: async (input) => {
      await saved.shut;
      return store.handlers.set(input);
    },
  });
  const sending = s.actor.call("chat", "send", { text: "Never mind." });
  await new Promise((resolve) => setImmediate(resolve));
  await s.actor.call("chat", "cancel", {});
  saved.open();
  await sending;
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.requests.length, 0);
});

test("cancel during a tool call keeps its real result and skips the calls after it", async () => {
  const s = await setup();
  const running = gate();
  const release = gate();
  let entered = 0;
  s.actor.bind("layout", {
    place: async () => {
      entered++;
      running.open();
      await release.shut;
      return { id: "p1" };
    },
  });
  s.script.push(
    calls(
      callTool("layout__place", { actor: "b", module: "panel" }, "g1"),
      callTool("layout__place", { actor: "b", module: "panel" }, "g2"),
    ),
    say("never"),
  );
  const from = s.actor.emitted.length;
  await s.actor.call("chat", "send", { text: "Place it twice." });
  await running.shut;
  await s.actor.call("chat", "cancel", {});
  assert.deepEqual(s.statuses(from).at(-1), { state: "idle" });
  release.open();
  await until(() => s.messages().length === 3, "both calls recorded");
  assert.equal(entered, 1);
  assert.deepEqual(s.messages().slice(1), [
    "tool: layout__place: done",
    "tool: layout__place: cancelled",
  ]);
  assert.equal(s.requests.length, 1, "no model call after the cancel");
  // The next turn starts clean, with every call answered.
  await s.turn("Next.");
  const input = s.requests.at(-1)?.input ?? [];
  for (const [i, item] of input.entries())
    if (item.type === "function_call") assert.equal(input[i + 1]?.callId, item.callId);
});

test("one turn at a time", async () => {
  const s = await setup();
  const late = gate<Reply>();
  s.script.push(() => late.shut);
  const from = s.actor.emitted.length;
  await s.actor.call("chat", "send", { text: "First." });
  await assert.rejects(s.actor.call("chat", "send", { text: "Second." }), { code: "busy" });
  late.open(say("Done."));
  await s.ended(from);
  await s.turn("Third.");
});

test("streamed text reaches the chat as the reply it becomes", async () => {
  const s = await setup();
  s.script.push((request) => {
    s.model.emit("delta", { requestId: "someone-else", text: "not ours" });
    s.model.emit("delta", { requestId: request.requestId, text: "Hel" });
    s.model.emit("delta", { requestId: request.requestId, text: "lo." });
    return say("Hello.");
  });
  await s.turn("Hi.");
  const deltas = s.actor.emitted.filter((e) => e.event === "delta").map((e) => e.payload);
  const reply = s.actor.emitted
    .filter((e) => e.event === "message")
    .map((e) => e.payload as { id: string; role: string })
    .find((m) => m.role === "assistant");
  // The reply's chat id is its own, not the model request's.
  assert.notEqual(reply?.id, s.requests[0]?.requestId);
  assert.deepEqual(deltas, [
    { id: reply?.id, text: "Hel" },
    { id: reply?.id, text: "lo." },
  ]);
  // The next user message has a number of its own, never the reply's id.
  const next = (await s.actor.call("chat", "send", { text: "Again." })) as { messageId: string };
  assert.notEqual(next.messageId, reply?.id);
});

test("a refusal from the model ends the turn with its code, and no idle after", async () => {
  const s = await setup();
  for (const code of ["usage_limit", "not_signed_in", "unavailable", "ineligible"]) {
    s.script.push(() => {
      throw new Refused(code, `refused: ${code}`);
    });
    const from = s.actor.emitted.length;
    const status = await s.turn("Try.");
    assert.deepEqual(status, { state: "error", detail: { code, message: `refused: ${code}` } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.statuses(from).at(-1)?.state, "error");
  }
  s.actor.unbind("model");
  assert.deepEqual((await s.turn("Anyone?")).detail, {
    code: "not_connected",
    message: "model is not connected.",
  });
  assert.ok(s.actor.logs.some((line) => line.message === "A turn failed."));
});

test("outputs are capped in bytes, refusals too, and a long reply is shown in part", async () => {
  const s = await setup();
  s.actor.bind("layout", {
    remove: () => {
      throw new Refused("invalid", "x".repeat(250_000));
    },
  });
  const named = (name: string) => [
    {
      actorId: "a",
      name,
      package: "external" as const,
      state: "running" as const,
      connected: true,
      restarts: 0,
    },
  ];
  s.actor.bind("actors", { list: () => ({ actors: named("é".repeat(60_000)) }) });
  const long = "y".repeat(150_000);
  s.script.push(
    calls(callTool("actors__list", {}, "a"), callTool("layout__remove", { id: "x" }, "b")),
    say(long),
  );
  assert.deepEqual(await s.turn("Big."), { state: "idle" });
  const sent = s.requests.at(-1)?.input ?? [];
  const outputs = sent.filter((i) => i.type === "function_call_output");
  assert.equal(outputs.length, 2);
  for (const item of outputs) {
    assert.ok(bytes(item.output as string) <= MAX_OUTPUT);
    assert.match(item.output as string, /… \(cut\)$/);
  }
  const shown = s.actor.emitted
    .filter((e) => e.event === "message")
    .map((e) => e.payload as { role: string; text: string })
    .find((m) => m.role === "assistant");
  assert.equal(shown?.text.length, 100_000);
  // The record keeps the whole reply, and the chat still pages and goes on.
  await s.turn("Next.");
  assert.ok(s.requests.at(-1)?.input.some((item) => item.content === long));
  const page = (await s.actor.call("chat", "history", {})) as { messages: unknown[] };
  assert.ok(page.messages.length > 0);
});

test("history pages back, survives a restart, and skips what doesn't read back", async () => {
  const values = new Map<string, unknown>();
  const s = await setup(values);
  for (let i = 1; i <= 5; i++) await s.turn(`Message ${i}.`);
  const page = (await s.actor.call("chat", "history", { limit: 4 })) as {
    messages: { id: string; text: string }[];
    more: boolean;
  };
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["Message 4.", "ok", "Message 5.", "ok"],
  );
  assert.equal(page.more, true);
  const older = (await s.actor.call("chat", "history", {
    before: page.messages[0]?.id,
    limit: 100,
  })) as {
    messages: unknown[];
    more: boolean;
  };
  assert.equal(older.messages.length, 6);
  assert.equal(older.more, false);
  assert.deepEqual(await s.actor.call("chat", "history", { before: "nothing-like-it" }), {
    messages: [],
    more: false,
  });

  // Another process, the same store, one record broken: it is left out, and nothing is overwritten.
  const keys = [...values.keys()].sort();
  values.set(keys[1] as string, { not: "an entry" });
  const restarted = await setup(values);
  const all = (await restarted.actor.call("chat", "history", { limit: 200 })) as {
    messages: unknown[];
  };
  assert.equal(all.messages.length, 9);
  await restarted.turn("After.");
  assert.equal(values.size, 12);
  assert.ok(restarted.actor.logs.some((line) => line.level === "warn"));
});

test("the model gets the newest whole exchanges that fit, and a call keeps its output", async () => {
  const s = await setup();
  s.actor.bind("layout", { get: () => ({ home: [] }) });
  s.script.push(calls(callTool("layout__get", {}, "first")));
  await s.turn("Message 1.");
  const bigs = Array.from({ length: 5 }, (_, i) => `${i}${"x".repeat(95_000)}`);
  for (const big of bigs) await s.turn(big);
  await s.turn("Small.");
  const sent = s.requests.at(-1)?.input ?? [];
  const texts = sent.map((item) => item.content as string);
  assert.equal(texts.includes("Message 1."), false);
  assert.equal(
    sent.some((item) => item.callId === "first"),
    false,
    "the call left with its exchange",
  );
  assert.equal(texts.includes(bigs[0] as string), false);
  assert.equal(texts.includes(bigs[4] as string), true);
  assert.equal(texts.at(-1), "Small.");
  assert.ok(bytes(JSON.stringify(sent)) <= INPUT_BUDGET);
});

test("a latest exchange over the budget leaves out its oldest outputs, never a call", async () => {
  const s = await setup();
  s.actor.bind("actors", {
    list: () => ({
      actors: [
        {
          actorId: "a",
          name: "z".repeat(15_000),
          package: "external" as const,
          state: "running" as const,
          connected: true,
          restarts: 0,
        },
      ],
    }),
  });
  for (let i = 0; i < 20; i++) s.script.push(calls(callTool("actors__list", {}, `k${i}`)));
  s.script.push(say("done"));
  await s.turn("é".repeat(99_000));
  const big = s.requests.at(-1)?.input ?? [];
  assert.ok(bytes(JSON.stringify(big)) <= INPUT_BUDGET + 20_000);
  const outputs = big.filter((item) => item.type === "function_call_output");
  assert.equal(outputs.length, big.filter((item) => item.type === "function_call").length);
  assert.ok(outputs.some((item) => String(item.output).startsWith("(Left out")));
});

test("binding another store reads that one", async () => {
  const s = await setup();
  await s.turn("In the first store.");
  s.actor.bind("store", memory().handlers);
  const page = (await s.actor.call("chat", "history", {})) as { messages: unknown[] };
  assert.deepEqual(page.messages, []);
});

test("a cancelled turn's running call is recorded before the next message", async () => {
  const s = await setup();
  const release = gate();
  let entered = false;
  s.actor.bind("layout", {
    get: async () => {
      entered = true;
      await release.shut;
      return { home: [] };
    },
  });
  s.script.push(calls(callTool("layout__get", {}, "c1"), callTool("layout__get", {}, "c2")));
  await s.actor.call("chat", "send", { text: "One." });
  await until(() => entered, "the call to start");
  await s.actor.call("chat", "cancel", {});
  const sending = s.actor.call("chat", "send", { text: "Two." });
  release.open();
  await sending;
  await until(() => s.messages().includes("assistant: ok"), "the second turn");
  assert.deepEqual(s.messages(), [
    "user: One.",
    "tool: layout__get: done",
    "tool: layout__get: cancelled",
    "user: Two.",
    "assistant: ok",
  ]);
  assert.equal(s.actor.logs.filter((line) => line.message === "A turn failed.").length, 0);
});

test("thousands of calls in one reply cost a handful of writes", async () => {
  const s = await setup();
  s.actor.bind("layout", { get: () => ({ home: [] }) });
  s.script.push(
    calls(...Array.from({ length: 2000 }, (_, i) => callTool("layout__get", {}, `x${i}`))),
  );
  const before = s.store.writes.count;
  assert.equal((await s.turn("Flood.")).detail?.code, "limit");
  // The message, 20 calls, and one entry answering the other 1,980.
  assert.equal(s.store.writes.count - before, 22);
  const input = (await s.actor.call("chat", "history", { limit: 200 })) as { messages: unknown[] };
  assert.equal(input.messages.length, 22);
});

test("a long message is stored once, under storage's value limit, and a big call is still kept", async () => {
  const s = await setup();
  s.actor.bind("layout", { get: () => ({ home: [] }) });
  // 45,000 CJK characters are 135 KB of UTF-8: stored twice, they would pass 256 KiB.
  assert.deepEqual(await s.turn("漢".repeat(45_000)), { state: "idle" });
  const big = { pad: "x".repeat(190_000) };
  s.script.push(calls(callTool("layout__get", big, "big")), say("done"));
  assert.deepEqual(await s.turn("Big arguments."), { state: "idle" });
  for (const value of s.store.values.values())
    assert.ok(bytes(JSON.stringify(value)) <= VALUE_LIMIT);
  // The call ran and is recorded, its arguments left out of the record.
  const sent = s.requests.at(-1)?.input ?? [];
  const call = sent.find((item) => item.callId === "big");
  assert.ok(call);
  assert.match(call.arguments as string, /left_out/);
  assert.equal(
    sent.find((item) => item.type === "function_call_output" && item.callId === "big")?.output,
    '{"home":[]}',
  );
});

test("calls with large arguments never take a request past its budget", async () => {
  const s = await setup();
  s.actor.bind("layout", { get: () => ({ home: [] }) });
  // Arguments, not outputs, fill this exchange: only leaving out old arguments keeps it in budget.
  for (let i = 0; i < 20; i++)
    s.script.push(calls(callTool("layout__get", { pad: "y".repeat(15_000) }, `a${i}`)));
  await s.turn("é".repeat(99_000));
  for (const request of s.requests)
    assert.ok(bytes(JSON.stringify(request.input)) <= INPUT_BUDGET + 20_000);
  const last = s.requests.at(-1)?.input ?? [];
  assert.equal(
    last.filter((item) => item.type === "function_call").length,
    last.filter((item) => item.type === "function_call_output").length,
  );
});

test("state says what the agent is doing, for a view that opens late", async () => {
  const s = await setup();
  assert.deepEqual(await s.actor.call("chat", "state", {}), { state: "idle" });
  const late = gate<Reply>();
  s.script.push(() => late.shut);
  const from = s.actor.emitted.length;
  await s.actor.call("chat", "send", { text: "Think." });
  await until(() => s.requests.length === 1, "the model request");
  assert.deepEqual(await s.actor.call("chat", "state", {}), { state: "thinking" });
  late.open(say("Done."));
  await s.ended(from);
  assert.deepEqual(await s.actor.call("chat", "state", {}), { state: "idle" });
  s.script.push(() => {
    throw new Refused("usage_limit", "Usage limit reached.");
  });
  await s.turn("Again.");
  assert.deepEqual(await s.actor.call("chat", "state", {}), {
    state: "error",
    detail: { code: "usage_limit", message: "Usage limit reached." },
  });
});

test("retry runs the last turn again without recording the message twice", async () => {
  const s = await setup();
  await assert.rejects(s.actor.call("chat", "retry", {}), { code: "nothing_to_retry" });
  s.script.push(() => {
    throw new Refused("unavailable", "Try again later.");
  });
  const first = (await s.actor.call("chat", "send", { text: "Hello." })) as { messageId: string };
  await s.ended(0);
  const from = s.actor.emitted.length;
  const again = (await s.actor.call("chat", "retry", {})) as { messageId: string };
  assert.equal(again.messageId, first.messageId);
  assert.deepEqual(await s.ended(from), { state: "idle" });
  const input = s.requests.at(-1)?.input ?? [];
  assert.equal(input.filter((item) => item.content === "Hello.").length, 1);
  assert.deepEqual(s.messages(), ["user: Hello.", "assistant: ok"]);
  // Not during a turn.
  const late = gate<Reply>();
  s.script.push(() => late.shut);
  await s.actor.call("chat", "retry", {});
  await assert.rejects(s.actor.call("chat", "retry", {}), { code: "busy" });
  late.open(say("Done."));
});

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  defineActor,
  defineInterface,
  describeInterface,
  event,
  type Log,
  method,
  NotConnected,
  Refused,
} from "../src/index.ts";
import { createRuntime } from "../src/runtime.ts";
import { createTestContext } from "../src/testing.ts";

const quests = defineInterface({
  name: "quests",
  major: 1,
  kind: "rpc",
  methods: {
    get: method({ input: z.object({}), output: z.object({ quests: z.array(z.string()) }) }),
    complete: method({ input: z.object({ quest: z.string().min(1) }), output: z.object({}) }),
  },
  events: { changed: event(z.object({ count: z.number() })) },
});
const PROVIDER = { actor: "act_q", export: "logic.quests" };
const quiet: Log = { info() {}, warn() {}, error() {} };
/** Turns of the event loop, for what arrives over the in-memory channel. */
test("a slot made at run time is listed while bound, called, listened to, and gone with its binding", async () => {
  const t = createTestContext(defineActor({ start() {} }));
  await t.start();
  let changes = 0;
  t.ctx.onExposed(() => changes++);
  assert.deepEqual(t.ctx.exposed(), []);

  const done: string[] = [];
  const binding = t.expose(
    "quests_quests",
    quests,
    {
      get: () => ({ quests: ["walk"] }),
      complete: ({ quest }) => {
        done.push(quest);
        return {};
      },
    },
    PROVIDER,
  );
  assert.equal(changes, 1);
  const [slot] = t.ctx.exposed();
  assert.ok(slot);
  assert.equal(slot.slot, "quests_quests");
  assert.deepEqual(slot.provider, PROVIDER);
  assert.deepEqual(slot.described, describeInterface(quests));
  assert.deepEqual(Object.keys(slot.call).sort(), ["complete", "get"]);
  assert.deepEqual(await slot.call.get?.({}), { quests: ["walk"] });
  await slot.call.complete?.({ quest: "walk" });
  assert.deepEqual(done, ["walk"]);
  await assert.rejects(
    slot.call.complete?.({ quest: "" }) ?? Promise.resolve(),
    (error: Refused) => {
      return error instanceof Refused && error.code === "invalid";
    },
  );

  const seen: unknown[] = [];
  const off = slot.on("changed", (payload) => seen.push(payload));
  binding.emit("changed", { count: 1 });
  assert.deepEqual(seen, [{ count: 1 }]);
  assert.throws(() => slot.on("nope", () => {}), TypeError);

  // Given again with the same export, it is usable again: listed once, nothing announced, and
  // what was listened to resumes from the provider as it is now.
  const again = t.expose("quests_quests", quests, {}, PROVIDER);
  assert.equal(changes, 1);
  assert.equal(t.ctx.exposed().length, 1);
  again.emit("changed", { count: 2 });
  assert.deepEqual(seen, [{ count: 1 }, { count: 2 }]);

  off();
  t.unexpose("quests_quests");
  assert.equal(changes, 2);
  assert.deepEqual(t.ctx.exposed(), []);
  await assert.rejects(slot.call.get?.({}) ?? Promise.resolve(), NotConnected);
});

test("an onExposed handler that throws is logged, and the others still run", async () => {
  const t = createTestContext(defineActor({ start() {} }));
  await t.start();
  let ran = false;
  t.ctx.onExposed(() => {
    throw new Error("boom");
  });
  const stop = t.ctx.onExposed(() => {
    ran = true;
  });
  t.expose("q", quests, {});
  assert.ok(ran);
  assert.ok(t.logs.some((line) => line.level === "error" && line.message.includes("onExposed")));
  stop();
  ran = false;
  t.unexpose("q");
  assert.equal(ran, false);
});

test("a subscription that ends at once leaves nothing live, and starts again when the slot is usable", async () => {
  const runtime = createRuntime(defineActor({ start() {} }), {
    self: { actorId: "act_a", module: "logic" },
    log: quiet,
    onEmit() {},
  });
  await runtime.start();
  let subscribed = 0;
  const source = {
    described: describeInterface(quests),
    provider: PROVIDER,
    call: async () => ({}),
    subscribe(_event: string, _onEvent: (payload: unknown) => void, onEnd: () => void) {
      subscribed++;
      onEnd();
      return () => {};
    },
  };
  runtime.expose("q", source);
  const [slot] = runtime.ctx.exposed();
  assert.doesNotThrow(() => slot?.on("changed", () => {}));
  assert.equal(subscribed, 1);
  runtime.expose("q", source);
  assert.equal(subscribed, 2);
});

test("the test context checks an exposed slot's input as JSON, as the Hub does", async () => {
  const stamped = defineInterface({
    name: "stamped",
    major: 1,
    kind: "rpc",
    methods: { put: method({ input: z.object({ at: z.string() }), output: z.object({}) }) },
  });
  const t = createTestContext(defineActor({ start() {} }));
  await t.start();
  const seen: unknown[] = [];
  t.expose("s", stamped, {
    put: (input) => {
      seen.push(input);
      return {};
    },
  });
  await t.ctx.exposed()[0]?.call.put?.({ at: new Date(0) });
  assert.deepEqual(seen, [{ at: "1970-01-01T00:00:00.000Z" }]);
});

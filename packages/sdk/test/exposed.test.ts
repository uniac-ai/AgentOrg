import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeFrame,
  eventBody,
  FrameReader,
  memoryPair,
  parseHeader,
  result,
  Session,
} from "@agentorg/wire";
import { z } from "zod";
import { openChannel } from "../src/client.ts";
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
import { ModuleHost } from "../src/module-host.ts";
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
const tick = async (turns = 20) => {
  for (let i = 0; i < turns; i++) await new Promise((done) => setImmediate(done));
};

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

/**
 * A Hub stand-in at the wire's level: it answers hello with `snapshot`, serves the exposed slot's
 * calls and subscriptions, and sends notices on `notify`.
 */
function fakeHub(snapshot: unknown) {
  const [here, there] = memoryPair();
  const calls: { slot: string; method: string; input: unknown }[] = [];
  const subscribers: ((payload: unknown) => void)[] = [];
  const hub = new Session(there, {
    client: false,
    onStream(stream) {
      void (async () => {
        const reader = new FrameReader(stream.readable);
        const header = parseHeader(await reader.next());
        const writer = stream.writable.getWriter();
        if (header.op === "hello") {
          await writer.write(encodeFrame(result(snapshot)));
          await writer.close();
        } else if (header.op === "call") {
          const body = (await reader.next()) as { input: unknown };
          calls.push({ slot: header.slot, method: header.method, input: body.input });
          await writer.write(encodeFrame(result({ quests: ["from the hub"] })));
          await writer.close();
        } else if (header.op === "subscribe") {
          subscribers.push((payload) => void writer.write(encodeFrame(eventBody(payload))));
        }
      })();
    },
  });
  return {
    channel: here,
    calls,
    emit: (payload: unknown) => {
      for (const send of subscribers) send(payload);
    },
    async notify(notice: Record<string, unknown>) {
      const stream = hub.open();
      const writer = stream.writable.getWriter();
      await writer.write(encodeFrame({ op: "slot", ...notice }));
      await writer.close();
      await tick();
    },
    close: () => hub.close(),
  };
}

test("over a channel, the notices make and remove exposed slots on every module", async () => {
  const described = describeInterface(quests);
  const exposure = { interface: described, provider: PROVIDER };
  // Hello names an exposed slot among the bound; its notice, with its exposure, follows.
  const hub = fakeHub({ actorId: "act_a", bound: ["logic.store", "first_quests"] });
  // Two modules of one Actor, as runHost joins them to one channel.
  const hosts = ["logic", "chat"].map((name) => {
    const definition = defineActor({ start() {} });
    const host = new ModuleHost(`${name}.`, definition.slots, quiet);
    host.runtime = createRuntime(definition, {
      self: { actorId: "act_a", module: name },
      log: quiet,
      ...host.hooks(),
    }) as unknown as ModuleHost["runtime"];
    return host;
  });
  const slotNotices: string[] = [];
  const channel = await openChannel({
    channel: hub.channel,
    actorId: "act_a",
    onSlot: (name) => slotNotices.push(name),
    onExposed: (name, found) => {
      for (const host of hosts) host.onExposed(name, found);
    },
  });
  // Its notice arrives before the modules attach: attaching takes it from the channel.
  await hub.notify({ name: "first_quests", bound: true, exposed: exposure });
  for (const host of hosts) host.attach(channel);
  const names = (host: ModuleHost) => host.runtime.ctx.exposed().map((s) => s.slot);
  for (const host of hosts) assert.deepEqual(names(host), ["first_quests"]);
  assert.deepEqual([...channel.exposed.keys()], ["first_quests"]);
  assert.ok(channel.bound.has("first_quests") && channel.bound.has("logic.store"));

  // A call goes out under the Actor's slot name, with no module prefix.
  const [logic] = hosts;
  const slot = logic?.runtime.ctx.exposed()[0];
  assert.deepEqual(await slot?.call.get?.({}), { quests: ["from the hub"] });
  assert.deepEqual(hub.calls, [{ slot: "first_quests", method: "get", input: {} }]);

  const seen: unknown[] = [];
  slot?.on("changed", (payload) => seen.push(payload));
  await tick();
  hub.emit({ count: 2 });
  await tick();
  assert.deepEqual(seen, [{ count: 2 }]);

  await hub.notify({ name: "second_quests", bound: true, exposed: exposure });
  for (const host of hosts) assert.deepEqual(names(host), ["first_quests", "second_quests"]);
  await hub.notify({ name: "first_quests", bound: false });
  for (const host of hosts) assert.deepEqual(names(host), ["second_quests"]);
  assert.equal(channel.exposed.has("first_quests"), false);
  // Notices for exposed slots never reach onSlot; a declared slot's still do.
  await hub.notify({ name: "logic.store", bound: false });
  assert.deepEqual(slotNotices, ["logic.store"]);

  // The channel going takes them all.
  hub.close();
  await channel.closed;
  await tick();
  for (const host of hosts) assert.deepEqual(names(host), []);
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

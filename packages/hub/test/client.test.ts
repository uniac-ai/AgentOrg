import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hubActors, hubExports, hubGrants } from "@agentorg/interfaces";
import {
  defineInterface,
  event,
  method,
  NotConnected,
  OutcomeUnknown,
  Refused,
} from "@agentorg/sdk";
import { type ConnectOptions, connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { Hub, listen, PERSON } from "../src/index.ts";

const notes = defineInterface({
  name: "notes",
  major: 1,
  kind: "rpc",
  methods: {
    write: method({
      input: z.object({ text: z.string().min(1) }),
      output: z.object({ n: z.number() }),
    }),
  },
  events: { written: event(z.object({ text: z.string() })) },
});
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 3000) => {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > ms) throw new Error("timed out waiting");
    await later(5);
  }
};
/** Emit until the listener hears it: the Hub opens the provider's side of a subscription a moment after. */
const emitUntilHeard = async (emit: () => void, heard: () => boolean) => {
  for (let i = 0; i < 300 && !heard(); i++) {
    emit();
    await later(10);
  }
  assert.ok(heard(), "the event was never heard");
};

type Options<S, X> = Omit<ConnectOptions<never, never>, "slots" | "exports"> & {
  slots?: S;
  exports?: X;
};

async function setup(t: test.TestContext) {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-client-")), "home");
  const hub = Hub.open(home);
  const server = await listen(hub);
  const open: { close(): void }[] = [];
  t.after(async () => {
    for (const client of open) client.close();
    await server.close();
    hub.close();
    rmSync(join(home, ".."), { recursive: true, force: true });
  });
  // The person keeps the slots it was bootstrapped with: it declares nothing.
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, grants: hubGrants, exports: hubExports },
    declare: false,
  });
  open.push(person);
  /** A new external Actor's id and credential, made through the person's hub.actors slot. */
  const makeActor = async (
    name: string,
    bindings?: { slot: string; provider: string; export: string }[],
  ) => {
    const made = await person.slots.actors.call.create({ name, ...(bindings ? { bindings } : {}) });
    assert.ok(made.credential, "an external Actor gets a credential");
    return { actorId: made.actorId, credential: made.credential };
  };
  /** Connect as an Actor; closed with the test. */
  const as = async <const S extends Record<string, never> | object, const X extends object>(
    who: { actorId: string; credential: string },
    shape: { slots?: S; exports?: X; declare?: boolean } = {},
  ) => {
    const client = await connect({ hubUrl: server.url, ...who, ...shape } as Options<
      S,
      X
    > as never);
    open.push(client);
    return client;
  };
  const bind = (consumer: string, slot: string, provider: string, exported: string) =>
    person.slots.grants.call.bind({ consumer, slot, provider, export: exported });
  return { hub, url: server.url, person, makeActor, bind, as };
}

test("bind, call, events, unbind and rebind through the client, with onBind and onUnbind", async (t) => {
  const { url, makeActor, bind, person } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const provider = await connect({ hubUrl: url, ...p, exports: { notes } });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes } });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  let count = 0;
  provider.exports.notes.implement({ write: async () => ({ n: ++count }) });
  const changes: string[] = [];
  consumer.slots.notes.onBind(() => changes.push("bind"));
  consumer.slots.notes.onUnbind(() => changes.push("unbind"));
  const heard: string[] = [];
  consumer.slots.notes.on("written", (payload) => heard.push(payload.text));
  assert.equal(consumer.slots.notes.bound, false);
  await assert.rejects(consumer.slots.notes.call.write({ text: "x" }), NotConnected);

  assert.deepEqual(await bind(c.actorId, "notes", p.actorId, "notes"), { bound: true });
  await until(() => consumer.slots.notes.bound);
  assert.deepEqual(await consumer.slots.notes.call.write({ text: "one" }), { n: 1 });
  await emitUntilHeard(
    () => provider.exports.notes.emit("written", { text: "first" }),
    () => heard.includes("first"),
  );

  await person.slots.grants.call.unbind({ consumer: c.actorId, slot: "notes" });
  await until(() => !consumer.slots.notes.bound);
  await assert.rejects(consumer.slots.notes.call.write({ text: "x" }), NotConnected);

  // After a rebind the listener hears again: the client subscribed anew.
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => consumer.slots.notes.bound);
  await emitUntilHeard(
    () => provider.exports.notes.emit("written", { text: "second" }),
    () => heard.includes("second"),
  );
  assert.deepEqual(changes, ["bind", "unbind", "bind"]);
});

test("an event sent to one caller reaches only that consumer; a handler knows its caller", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const a = await makeActor("alice");
  const b = await makeActor("bob");
  const provider = await connect({ hubUrl: url, ...p, exports: { notes } });
  const alice = await connect({ hubUrl: url, ...a, slots: { notes } });
  const bob = await connect({ hubUrl: url, ...b, slots: { notes } });
  t.after(() => {
    for (const client of [provider, alice, bob]) client.close();
  });
  const callers: string[] = [];
  provider.exports.notes.implement({
    write: async ({ text }, { caller }) => {
      callers.push(caller);
      provider.exports.notes.emit("written", { text }, { to: caller });
      return { n: callers.length };
    },
  });
  const heard: Record<string, string[]> = { alice: [], bob: [] };
  alice.slots.notes.on("written", ({ text }) => heard.alice?.push(text));
  bob.slots.notes.on("written", ({ text }) => heard.bob?.push(text));
  await bind(a.actorId, "notes", p.actorId, "notes");
  await bind(b.actorId, "notes", p.actorId, "notes");
  await until(() => alice.slots.notes.bound && bob.slots.notes.bound);
  // Both subscriptions are open once an event to everyone reaches both.
  await emitUntilHeard(
    () => provider.exports.notes.emit("written", { text: "all" }),
    () => Boolean(heard.alice?.includes("all") && heard.bob?.includes("all")),
  );
  await alice.slots.notes.call.write({ text: "for alice" });
  await bob.slots.notes.call.write({ text: "for bob" });
  await until(() => Boolean(heard.alice?.includes("for alice") && heard.bob?.includes("for bob")));
  await later(50);
  assert.deepEqual(callers, [a.actorId, b.actorId]);
  assert.deepEqual(
    heard.alice?.filter((text) => text !== "all"),
    ["for alice"],
  );
  assert.deepEqual(
    heard.bob?.filter((text) => text !== "all"),
    ["for bob"],
  );
});

test("a provider that restarts: onBind runs again and events resume, with bound unchanged", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const first = await connect({ hubUrl: url, ...p, exports: { notes } });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes } });
  t.after(() => consumer.close());
  first.exports.notes.implement({ write: async () => ({ n: 1 }) });
  const changes: string[] = [];
  consumer.slots.notes.onBind(() => changes.push("usable"));
  consumer.slots.notes.onUnbind(() => changes.push("unbound"));
  const heard: string[] = [];
  consumer.slots.notes.on("written", (payload) => heard.push(payload.text));
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => consumer.slots.notes.bound);
  await emitUntilHeard(
    () => first.exports.notes.emit("written", { text: "before" }),
    () => heard.includes("before"),
  );

  first.close();
  await first.closed;
  await later(50);
  assert.equal(consumer.slots.notes.bound, true, "a provider going away isn't an unbind");
  await assert.rejects(consumer.slots.notes.call.write({ text: "x" }), NotConnected);

  const back = await connect({ hubUrl: url, ...p, exports: { notes } });
  t.after(() => back.close());
  back.exports.notes.implement({ write: async () => ({ n: 2 }) });
  await until(() => changes.length === 2);
  assert.deepEqual(changes, ["usable", "usable"]);
  assert.deepEqual(await consumer.slots.notes.call.write({ text: "x" }), { n: 2 });
  await emitUntilHeard(
    () => back.exports.notes.emit("written", { text: "after" }),
    () => heard.includes("after"),
  );
});

test("errors come back as the SDK's", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const provider = await connect({ hubUrl: url, ...p, exports: { notes } });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes } });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  let arrived = () => {};
  const called = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  provider.exports.notes.implement({
    write: async ({ text }) => {
      if (text === "busy") throw new Refused("busy", "not now");
      if (text === "bug") throw new TypeError("it broke");
      if (text === "hang") {
        arrived();
        await new Promise(() => {});
      }
      return { n: 1 };
    },
  });
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => consumer.slots.notes.bound);

  // Checked here, as the Hub would: it never leaves the consumer.
  await assert.rejects(
    consumer.slots.notes.call.write({ text: "" }),
    (e: Refused) => e.code === "invalid",
  );
  await assert.rejects(
    consumer.slots.notes.call.write({ text: "busy" }),
    (e: Refused) => e.code === "busy",
  );
  await assert.rejects(
    consumer.slots.notes.call.write({ text: "bug" }),
    (e: Refused) => e.code === "failed",
    "a handler's own failure is failed, whatever its type",
  );

  // The consumer's own channel lost mid-call: OutcomeUnknown.
  const pending = consumer.slots.notes.call.write({ text: "hang" });
  await called;
  consumer.close();
  await assert.rejects(pending, OutcomeUnknown);
  await consumer.closed;
  assert.equal(consumer.slots.notes.bound, false, "a lost channel leaves nothing bound");
  await assert.rejects(consumer.slots.notes.call.write({ text: "x" }), NotConnected);

  await assert.rejects(
    connect({ hubUrl: url, ...c, credential: "wrong" }),
    (e: Refused) => e.code === "forbidden",
  );
  await assert.rejects(connect({ hubUrl: "ws://127.0.0.1:1", ...c }), NotConnected);
  await assert.rejects(connect({ hubUrl: "not a url", ...c }), NotConnected);
});

test("an Actor that declares nothing keeps what it declared before", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const provider = await connect({ hubUrl: url, ...p, exports: { notes } });
  t.after(() => provider.close());
  provider.exports.notes.implement({ write: async () => ({ n: 3 }) });
  const first = await connect({ hubUrl: url, ...c, slots: { notes } });
  first.close();
  await first.closed;
  await bind(c.actorId, "notes", p.actorId, "notes");
  const later_ = await connect({ hubUrl: url, ...c, slots: { notes }, declare: false });
  t.after(() => later_.close());
  assert.equal(later_.slots.notes.bound, true);
  assert.deepEqual(await later_.slots.notes.call.write({ text: "kept" }), { n: 3 });
});

test("sizes and async handlers fail where they belong", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const logs: string[] = [];
  const log = { info() {}, warn() {}, error: (message: string) => void logs.push(message) };
  const provider = await connect({ hubUrl: url, ...p, exports: { notes }, log });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes }, log });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  provider.exports.notes.implement({ write: async () => ({ n: 1 }) });
  // An async onBind that rejects is logged, not left unhandled.
  consumer.slots.notes.onBind(async () => {
    throw new Error("async trouble");
  });
  const heard: string[] = [];
  consumer.slots.notes.on("written", (payload) => heard.push(payload.text.slice(0, 5)));
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => consumer.slots.notes.bound && logs.includes("A slot handler threw."));
  // An input too large to send never ran anywhere: invalid.
  await assert.rejects(
    consumer.slots.notes.call.write({ text: "x".repeat(1_100_000) }),
    (e: Refused) => e.code === "invalid",
  );
  // An event too large to send doesn't throw at the emitter, and the next one still goes out.
  await emitUntilHeard(
    () => provider.exports.notes.emit("written", { text: "small" }),
    () => heard.includes("small"),
  );
  assert.doesNotThrow(() =>
    provider.exports.notes.emit("written", { text: "y".repeat(1_100_000) }),
  );
  await until(() => logs.includes("An event was too large to send."));
});

test("implement in start, use slots from onBind: a returning provider is ready before it is used", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  let generation = 0;
  const start = async (ctx: { exports: { notes: { implement(h: object): void } } }) => {
    const mine = ++generation;
    await later(30); // a slow start: the Hub mustn't reach the export before this ends
    ctx.exports.notes.implement({ write: async () => ({ n: mine }) });
  };
  const results: (number | string)[] = [];
  let duringStart: string | undefined;
  const consumer = await connect({
    hubUrl: url,
    ...c,
    slots: { notes },
    start(ctx) {
      duringStart = `${ctx.slots.notes.bound}`;
      ctx.slots.notes.onBind(() => {
        ctx.slots.notes.call.write({ text: "now" }).then(
          (r) => results.push(r.n),
          (e: Error) => results.push(e.name),
        );
      });
    },
  });
  t.after(() => consumer.close());
  assert.equal(duringStart, "false", "every slot reads unbound during start");
  let provider = await connect({ hubUrl: url, ...p, exports: { notes }, start });
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => results.length === 1);
  for (let restart = 2; restart <= 5; restart++) {
    provider.close();
    await provider.closed;
    provider = await connect({ hubUrl: url, ...p, exports: { notes }, start });
    await until(() => results.length === restart);
  }
  t.after(() => provider.close());
  assert.deepEqual(results, [1, 2, 3, 4, 5], "every call from onBind succeeded");
});

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  defineActor,
  defineInterface,
  event,
  method,
  NotConnected,
  Refused,
} from "../src/index.ts";
import { createTestContext } from "../src/testing.ts";

const notes = defineInterface({
  name: "notes",
  major: 1,
  kind: "rpc",
  methods: {
    read: method({ input: z.object({ key: z.string() }), output: z.object({ text: z.string() }) }),
    write: method({
      input: z.object({ key: z.string(), text: z.string().min(1) }),
      output: z.object({}),
    }),
  },
  events: { written: event(z.object({ key: z.string() })) },
});
const pipe = defineInterface({
  name: "pipe",
  major: 1,
  kind: "stream",
  protocol: "raw",
  open: z.object({ name: z.string() }),
});
const site = defineInterface({ name: "site", major: 1, kind: "http" });
const pair = () => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  return { readable, writable };
};

test("defineActor keeps its slots and exports", () => {
  const start = () => {};
  const actor = defineActor({ slots: { notes }, exports: { site }, start });
  assert.deepEqual(Object.keys(actor.slots), ["notes"]);
  assert.deepEqual(defineActor({ start }).slots, {});
});

test("slot and export names are checked", () => {
  const start = () => {};
  assert.throws(() => defineActor({ slots: { "my-notes": notes }, start }), /valid slot name/);
  assert.throws(() => defineActor({ exports: { Notes: notes }, start }), /valid export name/);
  // The types refuse it too; this is the check for code that bypasses them.
});

test("an rpc slot calls its bound provider, validates both ways, and fails clean when unbound", async () => {
  const t = createTestContext(defineActor({ slots: { notes }, start: () => {} }), {
    actorId: "writer",
    module: "logic",
  });
  const { slots, self } = t.ctx;
  assert.deepEqual(self, { actorId: "writer", module: "logic" });
  assert.equal(slots.notes.bound, false);
  await assert.rejects(slots.notes.call.read({ key: "a" }), NotConnected);
  const store = new Map<string, string>();
  t.bind("notes", {
    read: async ({ key }) => ({ text: store.get(key) ?? "" }),
    write: async ({ key, text }) => {
      store.set(key, text);
      return {};
    },
  });
  assert.equal(slots.notes.bound, true);
  await slots.notes.call.write({ key: "a", text: "hello" });
  assert.deepEqual(await slots.notes.call.read({ key: "a" }), { text: "hello" });
  await assert.rejects(
    slots.notes.call.write({ key: "a", text: "" }),
    (e: Refused) => e instanceof Refused && e.code === "invalid" && /text/.test(e.message),
  );
  t.unbind("notes");
  await assert.rejects(slots.notes.call.read({ key: "a" }), NotConnected);
});

test("a provider that answers outside the schema broke the contract after running: bad_output", async () => {
  const t = createTestContext(defineActor({ slots: { notes }, start: () => {} }));
  let ran = 0;
  t.bind("notes", {
    read: async () => {
      ran++;
      return { text: 1 } as never;
    },
  });
  await assert.rejects(
    t.ctx.slots.notes.call.read({ key: "a" }),
    (e: Refused) => e.code === "bad_output" && /output/.test(e.message),
  );
  assert.equal(ran, 1, "the provider ran: the caller reads state before retrying");
  // A caller's bad input is refused before anything runs.
  await assert.rejects(
    t.ctx.slots.notes.call.read({} as never),
    (e: Refused) => e.code === "invalid",
  );
  assert.equal(ran, 1);
  await assert.rejects(
    t.ctx.slots.notes.call.write({ key: "a", text: "b" }),
    (e: Refused) => e.code === "unimplemented",
  );
});

test("bind and unbind fire their callbacks, and events reach subscribers only from the current binding", async () => {
  const seen: string[] = [];
  const t = createTestContext(
    defineActor({
      slots: { notes },
      start(ctx) {
        ctx.slots.notes.onBind(() => seen.push("bind"));
        ctx.slots.notes.onUnbind(() => seen.push("unbind"));
      },
    }),
  );
  await t.start();
  const fake = {};
  const first = t.bind("notes", fake);
  const off = t.ctx.slots.notes.on("written", ({ key }) => seen.push(`written ${key}`));
  first.emit("written", { key: "a" });
  assert.throws(
    () => first.emit("written", {}),
    (e: Refused) => e.code === "bad_output",
  );
  t.unbind("notes");
  first.emit("written", { key: "after unbind" });
  // The same fake bound again is a new binding; the first one's handle no longer delivers.
  const second = t.bind("notes", fake);
  first.emit("written", { key: "stale" });
  second.emit("written", { key: "b" });
  off();
  second.emit("written", { key: "unsubscribed" });
  assert.deepEqual(seen, ["bind", "written a", "unbind", "bind", "written b"]);
});

test("names that every object has are not methods or events", async () => {
  const t = createTestContext(
    defineActor({
      slots: { notes },
      exports: { notes },
      start(ctx) {
        ctx.exports.notes.implement({ read: () => ({ text: "" }), write: () => ({}) });
      },
    }),
  );
  await t.start();
  assert.throws(() => t.ctx.slots.notes.on("hasOwnProperty" as never, () => {}), /no event/);
  await assert.rejects(t.call("notes", "toString", {}), /no method toString/);
  assert.throws(() => t.ctx.exports.notes.emit("constructor" as never, {} as never), /no event/);
});

test("an rpc export is called through its handlers and emits validated events", async () => {
  const t = createTestContext(
    defineActor({
      exports: { notes },
      start(ctx) {
        ctx.exports.notes.implement({
          read: ({ key }) => ({ text: key.toUpperCase() }),
          write: ({ key }) => {
            ctx.exports.notes.emit("written", { key });
            return {};
          },
        });
        ctx.log.info("ready", { exports: 1 });
      },
    }),
  );
  await assert.rejects(
    t.call("notes", "read", { key: "a" }),
    (e: Refused) => e.code === "unimplemented",
  );
  await t.start();
  assert.deepEqual(await t.call("notes", "read", { key: "a" }), { text: "A" });
  await t.call("notes", "write", { key: "k", text: "v" });
  assert.deepEqual(t.emitted, [{ export: "notes", event: "written", payload: { key: "k" } }]);
  await assert.rejects(
    t.call("notes", "write", { key: "k" }),
    (e: Refused) => e.code === "invalid",
  );
  assert.deepEqual(t.logs, [{ level: "info", message: "ready", fields: { exports: 1 } }]);
});

test("stream and http slots and exports carry bytes and requests", async () => {
  const opened: unknown[] = [];
  const t = createTestContext(
    defineActor({
      slots: { pipe, site },
      exports: { tunnel: pipe, web: site },
      start(ctx) {
        ctx.exports.tunnel.accept((params) => void opened.push(params));
        ctx.exports.web.serve((request) => new Response(new URL(request.url).pathname));
      },
    }),
  );
  await t.start();
  await assert.rejects(t.ctx.slots.pipe.open({ name: "a" }), NotConnected);
  t.bind("pipe", () => pair());
  assert.ok((await t.ctx.slots.pipe.open({ name: "a" })).readable instanceof ReadableStream);
  await assert.rejects(t.ctx.slots.pipe.open({ name: 1 } as never), Refused);
  t.bind("site", (request) => new Response(`got ${request.method}`));
  assert.equal(await (await t.ctx.slots.site.fetch(new Request("http://x/"))).text(), "got GET");
  await t.open("tunnel", { name: "b" }, pair());
  assert.deepEqual(opened, [{ name: "b" }]);
  assert.equal(await (await t.fetch("web", new Request("http://x/hello"))).text(), "/hello");
  await assert.rejects(t.call("web", "read", {}), /isn't an rpc export/);
});

test("a handler learns who called, and an event can go to one subscriber", async () => {
  const seen: string[] = [];
  const provider = defineActor({
    exports: { notes },
    start(ctx) {
      ctx.exports.notes.implement({
        read: ({ key }, { caller }) => {
          seen.push(caller);
          ctx.exports.notes.emit("written", { key }, { to: caller });
          return { text: key };
        },
        write: () => ({}),
      });
    },
  });
  const t = createTestContext(provider);
  await t.start();
  await t.call("notes", "read", { key: "a" }, "alice");
  await t.call("notes", "read", { key: "b" });
  assert.deepEqual(seen, ["alice", "test-actor"]);
  t.ctx.exports.notes.emit("written", { key: "all" });
  assert.deepEqual(t.emitted, [
    { export: "notes", event: "written", payload: { key: "a" }, to: "alice" },
    { export: "notes", event: "written", payload: { key: "b" }, to: "test-actor" },
    { export: "notes", event: "written", payload: { key: "all" } },
  ]);

  // A fake bound to a slot is called by the module itself.
  const consumer = defineActor({ slots: { notes }, start() {} });
  const c = createTestContext(consumer, { actorId: "bob" });
  await c.start();
  const callers: string[] = [];
  c.bind("notes", {
    read: ({ key }, { caller }) => {
      callers.push(caller);
      return { text: key };
    },
  });
  await c.ctx.slots.notes.call.read({ key: "x" });
  assert.deepEqual(callers, ["bob"]);
});

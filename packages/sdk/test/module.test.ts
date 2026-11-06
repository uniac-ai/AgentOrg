import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  defineActor,
  defineInterface,
  defineWidget,
  event,
  type FrameRoot,
  isFrameInterface,
  isModuleDefinition,
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
const Size = z.object({ width: z.number(), height: z.number() });
const frame = <const V extends number>(major: V) =>
  defineInterface({
    name: "ui.view",
    major,
    kind: "rpc",
    methods: {
      mount: method({
        input: z.object({ theme: z.record(z.string(), z.string()), size: Size }),
        output: z.object({}),
      }),
      resize: method({ input: z.object({ size: Size }), output: z.object({}) }),
      unmount: method({ input: z.object({}), output: z.object({}) }),
    },
  });
const view = frame(1);

const pair = () => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  return { readable, writable };
};

test("defineActor and defineWidget share one shape and record the placement", () => {
  const start = () => {};
  const actor = defineActor({ slots: { notes }, exports: { site }, start });
  const widget = defineWidget({ slots: { notes }, exports: { view }, start });
  assert.equal(actor.placement, "host");
  assert.equal(widget.placement, "view");
  assert.deepEqual(Object.keys(actor.slots), ["notes"]);
  assert.ok(isModuleDefinition(actor) && isModuleDefinition(widget));
  assert.equal(isModuleDefinition({ placement: "host" }), false);
  assert.deepEqual(defineActor({ start }).slots, {});
});

test("slot and export names are checked, and `add` is reserved", () => {
  const start = () => {};
  assert.throws(() => defineActor({ slots: { "my-notes": notes }, start }), /valid slot name/);
  assert.throws(() => defineActor({ exports: { Notes: notes }, start }), /valid export name/);
  // The types refuse it too; this is the check for code that bypasses them.
  assert.throws(() => defineActor({ exports: { add: notes } as never, start }), /reserved/);
});

test("only ui.view@1 is the in-frame interface", () => {
  assert.equal(isFrameInterface(view), true);
  assert.equal(isFrameInterface(frame(2)), false);
  assert.equal(isFrameInterface(notes), false);
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

test("a provider that answers outside the schema, or not at all, is refused", async () => {
  const t = createTestContext(defineActor({ slots: { notes }, start: () => {} }));
  t.bind("notes", { read: async () => ({ text: 1 }) as never });
  await assert.rejects(t.ctx.slots.notes.call.read({ key: "a" }), /output/);
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
  assert.throws(() => first.emit("written", {}), Refused);
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

test("an rpc export is called through its handlers, emits validated events, and stops when withdrawn", async () => {
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
  await assert.rejects(t.call("notes", "write", { key: "k" }), Refused);
  assert.deepEqual(t.logs, [{ level: "info", message: "ready", fields: { exports: 1 } }]);
  t.ctx.exports.notes.withdraw();
  assert.equal(t.withdrawn("notes"), true);
  await assert.rejects(t.call("notes", "read", { key: "a" }), NotConnected);
  assert.throws(() => t.ctx.exports.notes.emit("written", { key: "k" }), NotConnected);
  assert.throws(
    () => t.ctx.exports.notes.implement({ read: () => ({ text: "" }), write: () => ({}) }),
    NotConnected,
  );
});

test("exports can be added at run time under a free, valid name, including a withdrawn one", async () => {
  const t = createTestContext(
    defineActor({
      exports: { notes },
      start(ctx) {
        ctx.exports.add("extra", notes).implement({
          read: () => ({ text: "extra" }),
          write: () => ({}),
        });
      },
    }),
  );
  await t.start();
  assert.deepEqual(await t.call("extra", "read", { key: "x" }), { text: "extra" });
  assert.throws(() => t.ctx.exports.add("extra", notes), /already offered/);
  assert.throws(() => t.ctx.exports.add("notes", notes), /already offered/);
  assert.throws(() => t.ctx.exports.add("add", notes), /valid export name/);
  assert.throws(() => t.ctx.exports.add("Bad Name!", notes), /valid export name/);
  t.ctx.exports.notes.withdraw();
  t.ctx.exports
    .add("notes", notes)
    .implement({ read: () => ({ text: "again" }), write: () => ({}) });
  assert.deepEqual(await t.call("notes", "read", { key: "x" }), { text: "again" });
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

test("a ui.view@1 export mounts into an element, resizes and unmounts with validated input", async () => {
  const seen: unknown[] = [];
  const t = createTestContext(
    defineWidget({
      exports: { view },
      start(ctx) {
        ctx.exports.view.implement({
          mount(el, options) {
            seen.push(["mount", el, options]);
            return () => seen.push("unmount");
          },
          resize(size) {
            seen.push(["resize", size]);
          },
        });
      },
    }),
  );
  await t.start();
  const el = {} as FrameRoot;
  const options = { theme: { "--fg": "#000" }, size: { width: 300, height: 200 } };
  const mounted = t.mount("view", el, options);
  mounted.resize({ width: 10, height: 20 });
  assert.throws(() => mounted.resize({ width: 10 }), Refused);
  mounted.unmount();
  assert.deepEqual(seen, [
    ["mount", el, options],
    ["resize", { width: 10, height: 20 }],
    "unmount",
  ]);
  assert.throws(() => t.mount("view", el, { theme: {} }), Refused);
  await assert.rejects(t.call("view", "mount", options), /isn't an rpc export/);
  t.ctx.exports.view.withdraw();
  assert.throws(() => t.mount("view", el, options), NotConnected);
});

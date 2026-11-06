import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  defineActor,
  defineInterface,
  defineWidget,
  event,
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
const view = defineInterface({
  name: "ui.view",
  major: 1,
  kind: "rpc",
  methods: {
    mount: method({
      input: z.object({
        theme: z.record(z.string(), z.string()),
        size: z.object({ width: z.number(), height: z.number() }),
      }),
      output: z.object({}),
    }),
    resize: method({
      input: z.object({ size: z.object({ width: z.number(), height: z.number() }) }),
      output: z.object({}),
    }),
    unmount: method({ input: z.object({}), output: z.object({}) }),
  },
});

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
  assert.throws(() => defineActor({ exports: { add: notes }, start }), /reserved/);
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

test("bind and unbind fire their callbacks, and slot events reach subscribers until they leave", async () => {
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
  const provider = t.bind("notes", {});
  const off = t.ctx.slots.notes.on("written", ({ key }) => seen.push(`written ${key}`));
  provider.emit("written", { key: "a" });
  assert.throws(() => provider.emit("written", {}), Refused);
  off();
  provider.emit("written", { key: "b" });
  t.unbind("notes");
  provider.emit("written", { key: "c" });
  assert.deepEqual(seen, ["bind", "written a", "unbind"]);
});

test("an rpc export is called through its handlers, emits validated events, and can be withdrawn", async () => {
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
});

test("exports can be added at run time, under a new name", async () => {
  const t = createTestContext(
    defineActor({
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
  assert.throws(() => t.ctx.exports.add("extra", notes), /already exists/);
  assert.throws(() => t.ctx.exports.add("add", notes), /already exists/);
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
  await assert.rejects(t.call("web", "read", {}), /isn't a rpc export/);
});

test("a ui.view export is mounted into an element with validated options", async () => {
  const mounted: unknown[] = [];
  const t = createTestContext(
    defineWidget({
      exports: { view },
      start(ctx) {
        ctx.exports.view.implement({
          mount(el, options) {
            mounted.push([el, options]);
            return () => mounted.push("unmounted");
          },
        });
      },
    }),
  );
  await t.start();
  const el = {} as Element;
  const options = { theme: { "--fg": "#000" }, size: { width: 300, height: 200 } };
  const cleanup = t.mount("view", el, options);
  cleanup?.();
  assert.deepEqual(mounted, [[el, options], "unmounted"]);
  assert.throws(() => t.mount("view", el, { theme: {} }), Refused);
});

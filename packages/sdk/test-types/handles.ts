// Compiled by test/types.test.ts with tsc. Correct uses must compile. Each wrong use carries an
// expect-error marker, and an unused marker is itself an error, so a wrong call that starts to
// compile fails the test.
import { z } from "zod";
import { defineActor, defineInterface, defineWidget, event, method } from "../src/index.ts";
import { createTestContext } from "../src/testing.ts";

const Card = z.object({ id: z.string(), title: z.string(), done: z.boolean() });
const board = defineInterface({
  name: "board",
  major: 1,
  kind: "rpc",
  methods: {
    list: method({ input: z.object({}), output: z.object({ cards: z.array(Card) }) }),
    add: method({ input: z.object({ title: z.string().min(1) }), output: Card }),
  },
  events: { changed: event(z.object({ id: z.string() })) },
});
const shell = defineInterface({
  name: "computer.shell",
  major: 1,
  kind: "stream",
  protocol: "pty",
  open: z.object({ cols: z.number(), rows: z.number() }),
});
const site = defineInterface({ name: "site", major: 1, kind: "http" });
const Size = z.object({ width: z.number(), height: z.number() });
const uiView = defineInterface({
  name: "ui.view",
  major: 1,
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

export const actor = defineActor({
  slots: { board, shell, site },
  exports: { board },
  async start(ctx) {
    const { cards } = await ctx.slots.board.call.list({});
    const first: string | undefined = cards[0]?.title;
    const added = await ctx.slots.board.call.add({ title: "x" });
    const done: boolean = added.done;
    const off: () => void = ctx.slots.board.on("changed", (payload) => payload.id.toUpperCase());
    const bound: boolean = ctx.slots.board.bound;
    await ctx.slots.shell.open({ cols: 80, rows: 24 });
    await ctx.slots.site.fetch(new Request("http://site/"));
    ctx.exports.board.implement({
      list: async () => ({ cards: [] }),
      add: ({ title }) => ({ id: "1", title, done: false }),
    });
    ctx.exports.board.emit("changed", { id: "1" });
    ctx.exports.board.withdraw();
    const extra = ctx.exports.add("extra", board);
    extra.emit("changed", { id: "2" });
    ctx.log.info("started", { cards: cards.length });
    const id: string = ctx.self.actorId;
    void [first, done, off, bound, id];

    // @ts-expect-error: board@1 has no method `remove`.
    await ctx.slots.board.call.remove({ id: "1" });
    // @ts-expect-error: `add` needs a string `title`.
    await ctx.slots.board.call.add({ name: "x" });
    // @ts-expect-error: `title` is a string, not a number.
    await ctx.slots.board.call.add({ title: 1 });
    // @ts-expect-error: board@1 has no event `removed`.
    ctx.slots.board.on("removed", () => {});
    // @ts-expect-error: `changed`'s payload needs `id`.
    ctx.exports.board.emit("changed", {});
    // @ts-expect-error: a stream slot has no `call`.
    ctx.slots.shell.call;
    // @ts-expect-error: opening a pty needs `cols` and `rows`.
    await ctx.slots.shell.open({ cols: 80 });
    // @ts-expect-error: an http slot is fetched, not opened.
    await ctx.slots.site.open({});
    // @ts-expect-error: no slot named `store`.
    ctx.slots.store;
    // @ts-expect-error: a handler must return the method's output.
    ctx.exports.board.implement({ list: async () => ({ cards: [] }), add: () => ({ id: "1" }) });
  },
});

defineActor({
  exports: { board },
  start(ctx) {
    // @ts-expect-error: `implement` needs a handler for every method.
    ctx.exports.board.implement({ list: async () => ({ cards: [] }) });
  },
});

export const widget = defineWidget({
  slots: { board },
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el, { size }) {
        el.textContent = `${size.width}`;
        return () => {};
      },
      resize(size) {
        void size.height;
      },
    });
    const wire = {
      mount: async () => ({}),
      resize: async () => ({}),
      unmount: async () => ({}),
    };
    // @ts-expect-error: ui.view@1 is implemented with mount(el, options), not wire handlers.
    ctx.exports.view.implement(wire);
  },
});

export const servers = defineActor({
  exports: { tty: shell, web: site },
  start(ctx) {
    ctx.exports.tty.accept(({ cols }, stream) => void [cols.toFixed(), stream.readable]);
    ctx.exports.web.serve(async (request) => new Response(request.url));
    // @ts-expect-error: a stream export is accepted, not implemented.
    ctx.exports.tty.implement({});
    // @ts-expect-error: `accept` gets the open parameters, which have no `name`.
    ctx.exports.tty.accept(({ name }) => void name);
    // @ts-expect-error: an http handler returns a Response.
    ctx.exports.web.serve(() => "text");
  },
});

// @ts-expect-error: `add` is reserved for exports.add.
defineActor({ exports: { add: board }, start() {} });

const harness = createTestContext(actor);
harness.bind("board", { list: async () => ({ cards: [] }) });
harness.bind("shell", () => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  return { readable, writable };
});
// @ts-expect-error: a fake board handler must return the method's output.
harness.bind("board", { list: async () => ({ items: [] }) });
// @ts-expect-error: no slot named `store` to bind.
harness.bind("store", {});

// Compiled by test/types.test.ts with tsc. Correct uses must compile. Each wrong use carries an
// expect-error marker, and an unused marker is itself an error, so a wrong call that starts to
// compile fails the test.
import { z } from "zod";
import { defineActor, defineInterface, event, method } from "../src/index.ts";
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
export const actor = defineActor({
  slots: { board },
  exports: { board },
  async start(ctx) {
    const { cards } = await ctx.slots.board.call.list({});
    const first: string | undefined = cards[0]?.title;
    const added = await ctx.slots.board.call.add({ title: "x" });
    const done: boolean = added.done;
    const off: () => void = ctx.slots.board.on("changed", (payload) => payload.id.toUpperCase());
    const bound: boolean = ctx.slots.board.bound;
    ctx.exports.board.implement({
      list: async () => ({ cards: [] }),
      add: ({ title }, { caller }) => {
        const who: string = caller;
        return { id: who, title, done: false };
      },
    });
    ctx.exports.board.emit("changed", { id: "1" });
    ctx.exports.board.emit("changed", { id: "1" }, { to: "actor" });
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
    // @ts-expect-error: an event goes `to` an Actor's id, a string.
    ctx.exports.board.emit("changed", { id: "1" }, { to: 1 });
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

const harness = createTestContext(actor);
harness.bind("board", { list: async () => ({ cards: [] }) });
// @ts-expect-error: a fake board handler must return the method's output.
harness.bind("board", { list: async () => ({ items: [] }) });
// @ts-expect-error: no slot named `store` to bind.
harness.bind("store", {});

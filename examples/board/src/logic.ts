// The board's logic, in a host process.
import { kv } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import { board, Card } from "board-interfaces";
import { z } from "zod";

const Cards = z.array(Card);

export default defineActor({
  slots: { store: kv },
  exports: { board },
  async start(ctx) {
    const cards = async () =>
      ctx.slots.store.bound
        ? Cards.parse((await ctx.slots.store.call.get({ key: "cards" })).value ?? [])
        : [];
    ctx.exports.board.implement({
      list: async () => ({ cards: await cards() }),
      add: async ({ title }) => {
        const card = { id: crypto.randomUUID(), title, done: false };
        await ctx.slots.store.call.set({ key: "cards", value: [...(await cards()), card] });
        ctx.exports.board.emit("changed", { id: card.id });
        return card;
      },
    });
    ctx.slots.store.onBind(() => ctx.exports.board.emit("changed", { id: "*" }));
  },
});

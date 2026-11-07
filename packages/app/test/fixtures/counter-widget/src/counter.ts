// The counter's logic: one number, kept in its kv@1 store.
import { kv } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import { counter } from "./interface.ts";

export default defineActor({
  slots: { store: kv },
  exports: { counter },
  start(ctx) {
    const read = async () => {
      const { value } = await ctx.slots.store.call.get({ key: "count" });
      return typeof value === "number" ? value : 0;
    };
    ctx.exports.counter.implement({
      get: async () => ({ value: await read() }),
      increment: async () => {
        const value = (await read()) + 1;
        await ctx.slots.store.call.set({ key: "count", value });
        return { value };
      },
    });
  },
});

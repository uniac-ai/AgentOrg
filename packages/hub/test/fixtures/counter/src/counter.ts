// A test package with nothing outside what a Hub build allows: its count is kept in a kv@1 slot.
import { kv } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import { counter } from "./interface.ts";

export default defineActor({
  slots: { store: kv },
  exports: { counter },
  start(ctx) {
    ctx.exports.counter.implement({
      increment: async () => {
        const { value } = await ctx.slots.store.call.get({ key: "count" });
        const next = (typeof value === "number" ? value : 0) + 1;
        await ctx.slots.store.call.set({ key: "count", value: next });
        return { value: next };
      },
    });
  },
});

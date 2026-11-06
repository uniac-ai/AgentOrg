// A test package: slow to start, logs every way a module can, throws the SDK's errors, and
// crashes on request.
import { defineActor, defineInterface, method, NotConnected, Refused } from "@agentorg/sdk";
import { z } from "zod";

export const probe = defineInterface({
  name: "probe",
  major: 1,
  kind: "rpc",
  methods: {
    ping: method({ input: z.object({}), output: z.object({ ready: z.boolean() }) }),
    crash: method({ input: z.object({}), output: z.object({}) }),
    refuse: method({ input: z.object({}), output: z.object({}) }),
    unbound: method({ input: z.object({}), output: z.object({ notConnected: z.boolean() }) }),
    oddLog: method({ input: z.object({}), output: z.object({}) }),
    flood: method({ input: z.object({ lines: z.number().int() }), output: z.object({}) }),
  },
});

export default defineActor({
  slots: { other: probe },
  exports: { probe },
  async start(ctx) {
    ctx.log.info("starting", { step: 1 });
    console.log("plain stdout");
    console.error("plain stderr");
    // A slow start: the Hub mustn't reach the export before it is implemented.
    await new Promise((resolve) => setTimeout(resolve, 30));
    ctx.exports.probe.implement({
      ping: async () => ({ ready: true }),
      // The SDK's errors are made by the bundle's own copy of the SDK, not the runner's.
      refuse: async () => {
        throw new Refused("not_found", "no such thing");
      },
      unbound: async () => {
        try {
          await ctx.slots.other.call.ping({});
          return { notConnected: false };
        } catch (error) {
          return { notConnected: error instanceof NotConnected };
        }
      },
      flood: async ({ lines }) => {
        for (let i = 0; i < lines; i++) console.log(`flood ${i}`);
        return {};
      },
      oddLog: async () => {
        // A cycle with no prototype can't be turned into JSON or text.
        const cycle = Object.create(null) as Record<string, unknown>;
        cycle.self = cycle;
        ctx.log.info("odd", { n: 1n, error: new Error("e") });
        ctx.log.info(Object.create(null) as string);
        ctx.log.info("cycle", cycle);
        return {};
      },
      crash: async () => {
        setTimeout(() => {
          throw new Error("boom");
        }, 0);
        return {};
      },
    });
  },
});

// A host-only Actor, compiled without the DOM library: the SDK must not need DOM types here.
import { z } from "zod";
import { defineActor, defineInterface, method } from "../src/index.ts";

const ping = defineInterface({
  name: "ping",
  major: 1,
  kind: "rpc",
  methods: { ping: method({ input: z.object({}), output: z.object({ at: z.number() }) }) },
});

export default defineActor({
  exports: { ping },
  start(ctx) {
    ctx.exports.ping.implement({ ping: () => ({ at: Date.now() }) });
  },
});

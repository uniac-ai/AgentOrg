import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";

export const counter = defineInterface({
  name: "counter",
  major: 1,
  kind: "rpc",
  methods: {
    increment: method({ input: z.object({}), output: z.object({ value: z.number().int() }) }),
  },
});

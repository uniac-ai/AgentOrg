import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";

/** `llm.session@1`: model inference sessions. A stub; its full shape comes with the model Actor (step 5). */
export const llmSession = defineInterface({
  name: "llm.session",
  major: 1,
  kind: "rpc",
  methods: {
    create: method({
      input: z.object({ model: z.string().optional() }),
      output: z.object({ sessionId: z.string() }),
    }),
    send: method({
      input: z.object({ sessionId: z.string(), text: z.string() }),
      output: z.object({ text: z.string() }),
    }),
  },
});

import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

/** `chat@1`: a conversation with an agent. A stub; its full shape comes with the assistant (step 5). */
export const chat = defineInterface({
  name: "chat",
  major: 1,
  kind: "rpc",
  methods: {
    send: method({ input: z.object({ text: z.string().min(1) }), output: z.object({}) }),
  },
  events: {
    message: event(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })),
  },
});

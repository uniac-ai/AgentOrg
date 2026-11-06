import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

export const Card = z.object({ id: z.string(), title: z.string(), done: z.boolean() });

/** `board@1`: a task board's cards, with an event when one changes. */
export const board = defineInterface({
  name: "board",
  major: 1,
  kind: "rpc",
  methods: {
    list: method({ input: z.object({}), output: z.object({ cards: z.array(Card) }) }),
    add: method({ input: z.object({ title: z.string().min(1) }), output: Card }),
  },
  events: { changed: event(z.object({ id: z.string() })) },
});

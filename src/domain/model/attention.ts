/** The one read that waits: what concerns the caller, and which public records changed. */
import { z } from "zod";
import { toolDefinition } from "./json-schema.ts";
import { Id, MAX_WAIT_SECONDS, Timestamp } from "./records.ts";

export const AttentionRequest = z
  .strictObject({
    since: z
      .string()
      .regex(/^\d{1,15}$/, "the next of an earlier read")
      .optional()
      .describe(
        "The next of your previous read. Without it, the read returns at once with the current position.",
      ),
    wait: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .default(0)
      .describe("Seconds to wait when nothing has happened since; at most 600."),
  })
  .meta({ id: "AttentionRequest" });

export const AttentionItem = z
  .strictObject({
    kind: z
      .enum(["answer", "ask", "assigned", "review_due", "reviewed", "message"])
      .describe(
        "answer: to your ask. ask: a new one from a direct report. assigned: Work you now own. review_due: a submission for you to review. reviewed: a review of your submission. message: one to you.",
      ),
    recordID: z.string().describe("The formID, ticketID or messageID."),
    from: z.strictObject({ actorID: Id, name: z.string() }).describe("Who did it."),
    title: z.string().describe("The ask's or the Work's title, or the message's first line."),
    at: Timestamp,
  })
  .meta({ id: "AttentionItem" });

export const Attention = z
  .strictObject({
    items: z
      .array(AttentionItem)
      .describe("What concerns you and was done by someone else, oldest first."),
    changed: z
      .strictObject({
        actorIDs: z.array(Id).describe("Actors whose status changed."),
        workIDs: z.array(z.string()),
        formIDs: z.array(z.string()),
      })
      .describe("Status, Work and asks anyone changed, so a view can stay current."),
    next: z.string().describe("Pass it as since to continue after this read."),
  })
  .meta({ id: "Attention" });

export const ATTENTION = toolDefinition("attention", {
  attention: {
    writes: false,
    level: "report",
    request: AttentionRequest,
    response: Attention,
    description: `Read what concerns you since your last read: answers to your asks, new asks from your direct reports, Work assigned to you, reviews due and done, and Messages to you. Your own writes are not items. changed names the status, Work and asks anyone changed.

Returns at once when there is something; otherwise it waits up to wait seconds. Pass the returned next as since to continue, and give the call a timeout longer than wait.`,
  },
});

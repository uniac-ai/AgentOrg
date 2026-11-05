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
      .enum(["assigned", "updated", "reviewed", "answer", "message", "ask", "review_due"])
      .describe(
        "On your records: assigned (Work given to you), updated (Work you own, changed or cancelled by its requester), reviewed (your submission answered), answer (your ask answered, one per responder), message (one to you). Routed to you: ask (on Work you requested; for the person, also on Work its asker requested itself or on no Work, or passed by the close of the Actor it waited on; while it is open and still routed to you), review_due (a submission of Work you requested, or for the person of Work a closed Actor requested, while it waits).",
      ),
    recordID: z
      .string()
      .describe(
        "The ticketID for assigned, updated, reviewed and review_due; the askID for answer and ask; the messageID for message.",
      ),
    from: z.strictObject({ actorID: Id, name: z.string() }).describe("Who wrote it."),
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
        actorIDs: z
          .array(Id)
          .describe(
            "The parties of each write: a Work's owner, requester and previous owner, an ask's asker, a message's two Actors, and an Actor created or closed.",
          ),
        workIDs: z.array(z.string()).describe("Work written, and the Work each written ask is on."),
        conversationIDs: z.array(z.string()).describe("Conversations a message was sent in."),
      })
      .describe("What anyone's writes touched, so a view can stay current."),
    next: z.string().describe("Pass it as since to continue after this read."),
  })
  .meta({ id: "Attention" });

export const ATTENTION = toolDefinition("attention", {
  attention: {
    writes: false,
    request: AttentionRequest,
    response: Attention,
    description: `Read what concerns you since your last read. On your records: Work given to you or changed by its requester, an answer to your submission, an answer to your ask, and a message to you. Routed to you: an ask on Work you requested, and a submission of Work you requested. The person also gets the asks on Work their asker requested itself or on no Work, and stands in for closed Actors. Your own writes are not items. changed names the Actors, Work and conversations anyone's writes touched.

Returns at once when there is something; otherwise it waits up to wait seconds. Pass the returned next as since to continue, and give the call a timeout longer than wait.`,
  },
});

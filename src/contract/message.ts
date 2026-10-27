/** Messages: notes and reports that only go up, to the sender's manager. */

import { z } from "zod";
import { Id, LIMITS, Timestamp } from "./common.ts";

export const MessageKind = z.enum(["note", "report"]);
const Body = z.string().trim().min(1).max(LIMITS.body);

export const Message = z
  .strictObject({
    id: Id,
    from: Id.describe("The sending agent."),
    to: Id.nullable().describe("The sender's manager; null when it is the user."),
    kind: MessageKind,
    body: Body.describe("Plain text with line breaks, organized at the sender's level."),
    evidence: z.array(Id),
    sent_at: Timestamp,
    read_at: Timestamp.nullable(),
    acknowledged_at: Timestamp.nullable().describe(
      "Reports only: set when the recipient reviewed it.",
    ),
  })
  .meta({ id: "Message" });

export const MessageSend = z
  .strictObject({
    session: Id.describe("The sending session; the message goes to its agent's manager."),
    kind: MessageKind,
    body: Body,
  })
  .meta({ id: "MessageSend" });

export const InboxRead = z
  .strictObject({ session: Id.describe("A session of the reading agent.") })
  .meta({ id: "InboxRead" });

export const Inbox = z
  .strictObject({
    messages: z
      .array(Message)
      .describe("Unread messages, and reports not yet acknowledged, oldest first."),
  })
  .meta({ id: "Inbox" });

export const MessageAck = z
  .strictObject({
    session: Id.describe("A session of the report's recipient."),
    message: Id,
  })
  .meta({ id: "MessageAck" });

export const MessageReadAsUser = z
  .strictObject({ message: Id.describe("A note to the user.") })
  .meta({ id: "MessageReadAsUser" });

export const MessageAckAsUser = z
  .strictObject({ message: Id.describe("A report to the user.") })
  .meta({ id: "MessageAckAsUser" });

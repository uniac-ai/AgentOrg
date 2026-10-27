// What a toast says after each write: the outcome first, its subject second.

import { toasts } from "@/components/ui/toast";
import type { AskRecord, ClosedAgent, MessageRecord } from "../../../src/page/types.ts";

const firstLine = (text: string) => text.split("\n")[0] ?? text;

export const notices = {
  answered: (ask: AskRecord) =>
    toasts.add({ title: ask.answer?.choice ?? "Answered", description: ask.title }),
  acknowledged: (message: MessageRecord) =>
    toasts.add({ title: "Acknowledged", description: firstLine(message.body) }),
  read: (message: MessageRecord) =>
    toasts.add({ title: "Marked read", description: firstLine(message.body) }),
  closed: ({ agent }: ClosedAgent) => toasts.add({ title: "Closed", description: agent.title }),
  refused: (error: Error) =>
    toasts.add({ type: "error", title: "Not sent", description: error.message }),
};

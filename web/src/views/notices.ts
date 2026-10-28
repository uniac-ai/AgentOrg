// What a toast says after each write: the outcome first, its subject second.

import { toasts } from "@/components/ui/toast";
import type { ActorClosed, CallRecord } from "../../../src/human/types.ts";
import { callTitle } from "./calls.tsx";

const SETTLED: Record<string, string> = { note: "Marked read", report: "Acknowledged" };

export const notices = {
  answered: (call: CallRecord, output: Record<string, unknown>) =>
    toasts.add({
      title: SETTLED[call.tool] ?? (typeof output.choice === "string" ? output.choice : "Answered"),
      description: callTitle(call),
    }),
  closed: ({ actor }: ActorClosed) => toasts.add({ title: "Closed", description: actor.name }),
  refused: (error: Error) =>
    toasts.add({ type: "error", title: "Not sent", description: error.message }),
};

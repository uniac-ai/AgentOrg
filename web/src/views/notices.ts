// What a toast says after each write: the outcome first, its subject second.

import { toasts } from "@/components/ui/toast";
import type { ActorClosed, QuestionRecord } from "../../../src/human/types.ts";
import { firstLine, type Names, nameOf } from "./messages.tsx";

export const notices = {
  answered: (questions: QuestionRecord[], choice: string | undefined) =>
    toasts.add({
      title: choice ?? "Answered",
      description:
        questions.length === 1
          ? firstLine(questions[0]?.text ?? "")
          : `${questions.length} answered`,
    }),
  sent: (to: string, names: Names) => toasts.add({ title: "Sent", description: nameOf(to, names) }),
  read: (count: number) =>
    toasts.add({ title: "Marked read", description: count === 1 ? undefined : `${count}` }),
  closed: ({ actor }: ActorClosed) => toasts.add({ title: "Closed", description: actor.name }),
  refused: (error: Error) =>
    toasts.add({ type: "error", title: "Not sent", description: error.message }),
};

// The user's page, control: what waits on the user, the approvals only the user gives leading,
// then the other open questions addressed to the root, then the messages to the root not read
// yet, each oldest first. The answer or reply being written sits at its foot; the organization
// below. Keys on a focused card: 1–9 choose an option (on an approval, pick it, and ⌘/Ctrl+Enter
// sends the pick), x puts a question in the answer, r answers or replies, e marks a message read;
// Esc leaves the answer.

import { useQueries } from "@tanstack/react-query";
import { focusedRow, isTyping, useKeys, useRowKeys } from "@/lib/keys";
import type { MessageRecord, QuestionRecord } from "../../../src/human/types.ts";
import { useRead } from "../data/mutations.ts";
import { organizationQuery, questionsToQuery, unreadQuery } from "../data/queries.ts";
import { questionsForYou } from "../model/messages.ts";
import { openQuestions } from "../model/organization.ts";
import type { ComposerModel } from "../views/composer.tsx";
import type { MessageCardModel, QuestionCardModel } from "../views/messages.tsx";
import { notices } from "../views/notices.ts";
import { PaneSkeleton } from "../views/states.tsx";
import { YouView } from "../views/you.tsx";
import { type BelowModel, belowOf } from "./below.ts";
import { messageCardOf, namesOf, questionCardOf } from "./cards.ts";
import { useReply } from "./reply.ts";

export type WaitingCard =
  | ({ kind: "question" } & QuestionCardModel)
  | ({ kind: "message" } & MessageCardModel);

export interface YouModel {
  waiting: WaitingCard[];
  /** The answer or reply being written, once something is in it. */
  composer: ComposerModel | undefined;
  below: BelowModel;
}

export function YouControl() {
  const [organization, unread] = useQueries({ queries: [organizationQuery, unreadQuery] });
  const org = organization.data;
  const root = org?.root.id;
  const [toYou] = useQueries({ queries: [questionsToQuery(root)] });
  const questions =
    org && root && toYou.data ? questionsForYou(toYou.data, openQuestions(org), root) : [];
  const messages = [...(unread.data ?? [])].reverse();
  const names = org ? namesOf(org) : new Map<string, string>();
  const reply = useReply({
    questions: new Map(questions.map((question) => [question.id, question])),
    messages: new Map(messages.map((message) => [message.id, message])),
    names,
    to: undefined,
    placeholder: "Answer",
  });
  const read = useRead();
  useRowKeys();

  const markRead = (message: MessageRecord) =>
    read.mutate([message.id], { onSuccess: () => notices.read(1), onError: notices.refused });

  const questionKey = (event: KeyboardEvent, question: QuestionRecord) => {
    const option = /^[1-9]$/.test(event.key) ? question.options[Number(event.key) - 1] : undefined;
    if (option && reply.picked(question) !== undefined) reply.pick(question, option.label);
    else if (option) reply.choose(question, option.label);
    else if (event.key === "x") reply.select(question.id, !reply.selected.has(question.id));
    else if (event.key === "r") reply.answerInWords(question.id);
    else return false;
    return true;
  };

  useKeys((event) => {
    if (event.key === "Escape" && reply.replying) {
      reply.clear();
      return true;
    }
    if (isTyping(event)) return false;
    const id = focusedRow();
    const question = questions.find((each) => each.id === id);
    const picked = question && reply.picked(question);
    if (question && picked && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      reply.choose(question, picked);
      return true;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (question) return questionKey(event, question);
    const message = messages.find((each) => each.id === id);
    if (message && event.key === "r") reply.replyTo(message.id);
    else if (message && event.key === "e") markRead(message);
    else return false;
    return true;
  });

  if (!org || !toYou.data || !unread.data) return <PaneSkeleton />;
  const busy = reply.busy || read.isPending;
  const model: YouModel = {
    waiting: [
      ...questions.map((question) => ({
        kind: "question" as const,
        ...questionCardOf(question, org, names, {
          selected: reply.selected.has(question.id),
          busy,
          onSelect: (on) => reply.select(question.id, on),
          onChoose: (label) => reply.choose(question, label),
          onAnswer: () => reply.answerInWords(question.id),
          picked: reply.picked(question),
          onPick: (label) => reply.pick(question, label),
        }),
      })),
      ...messages.map((message) => ({
        kind: "message" as const,
        ...messageCardOf(message, org, names, {
          busy,
          onReply: () => reply.replyTo(message.id),
          onRead: () => markRead(message),
        }),
      })),
    ],
    composer: reply.replying ? reply.composer : undefined,
    below: belowOf(org.root, org),
  };
  return <YouView {...model} />;
}

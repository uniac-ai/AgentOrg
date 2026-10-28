/**
 * Questions and messages as the app reads them: what waits on the user, the options an answer to
 * several questions can choose from, and an actor's history as one timeline of its progress
 * versions, its questions with their answers, and its messages.
 */

import type { MessageRecord, ProgressRecord, QuestionRecord } from "../../../src/human/types.ts";

/**
 * The questions that wait on the user, oldest first, approvals only the user gives leading: those
 * addressed to the root, and every open approval whose answerer is the root, wherever addressed.
 */
export function questionsForYou(
  toYou: readonly QuestionRecord[],
  open: readonly QuestionRecord[],
  root: string,
): QuestionRecord[] {
  const waiting = new Map(toYou.map((question) => [question.id, question]));
  for (const question of open) {
    if (question.answerer === root && !waiting.has(question.id)) {
      waiting.set(question.id, question);
    }
  }
  const approval = (question: QuestionRecord) => (question.answerer === root ? 0 : 1);
  return [...waiting.values()].sort(
    (a, b) => approval(a) - approval(b) || a.created_at.localeCompare(b.created_at),
  );
}

/** The options every one of the questions offers, in the first one's order. */
export function sharedOptions(questions: readonly QuestionRecord[]): string[] {
  const [first, ...rest] = questions;
  if (first === undefined) return [];
  return first.options
    .map((option) => option.label)
    .filter((label) => rest.every((each) => each.options.some((option) => option.label === label)));
}

/** One answer's input: it resolves every question named, with a choice, the words, or both. */
export function answerOf(questions: readonly string[], choice: string | undefined, words: string) {
  const text = words.trim();
  return {
    questions: [...questions],
    ...(choice === undefined ? {} : { choice }),
    ...(text === "" ? {} : { text }),
  };
}

export type HistoryEntry =
  | { kind: "progress"; at: string; version: ProgressRecord }
  | { kind: "question"; at: string; question: QuestionRecord }
  | { kind: "message"; at: string; message: MessageRecord };

/** An actor's earlier progress, its questions and its messages, newest first, each once. */
export function timeline(
  versions: readonly ProgressRecord[],
  questions: readonly QuestionRecord[],
  messages: readonly MessageRecord[],
): HistoryEntry[] {
  const once = <T extends { id: string }>(records: readonly T[]) => [
    ...new Map(records.map((record) => [record.id, record])).values(),
  ];
  return [
    ...versions.map((version) => ({ kind: "progress" as const, at: version.updated_at, version })),
    ...once(questions).map((question) => ({
      kind: "question" as const,
      at: question.answer?.at ?? question.created_at,
      question,
    })),
    ...once(messages).map((message) => ({
      kind: "message" as const,
      at: message.created_at,
      message,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

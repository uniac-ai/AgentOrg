// What the user is writing, control, shared by every pane with a composer: an answer to the
// questions put in it, with its choice among the options they all share; or a reply to one
// message; or, with neither, a new message to the pane's actor, if any. An option answers its
// question at once, except on an approval, a question with an answerer: there it is picked, and a
// deliberate Send confirms it, since a permission gate's answer cannot be undone.

import { useState } from "react";
import type { MessageRecord, QuestionRecord } from "../../../src/clients/web/types.ts";
import { useAnswer, useSend } from "../data/mutations.ts";
import { answerOf, sharedOptions } from "../model/messages.ts";
import type { ComposerModel } from "../views/composer.tsx";
import type { Names } from "../views/messages.tsx";
import { notices } from "../views/notices.ts";

export function useReply(options: {
  /** The questions the answer may resolve, by id. */
  questions: ReadonlyMap<string, QuestionRecord>;
  /** The messages a reply may answer, by id. */
  messages: ReadonlyMap<string, MessageRecord>;
  names: Names;
  /** The actor a new message goes to; without one, the composer only answers and replies. */
  to: string | undefined;
  placeholder: string;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<string>();
  const [choice, setChoice] = useState<string>();
  const [words, setWords] = useState("");
  const [focus, setFocus] = useState(0);
  const [picks, setPicks] = useState<ReadonlyMap<string, string>>(new Map());
  const answer = useAnswer();
  const quick = useAnswer();
  const send = useSend();

  // A question answered elsewhere, or a message read elsewhere, leaves what is being written.
  const questions = chosen.flatMap((id) => options.questions.get(id) ?? []);
  const message = replyTo === undefined ? undefined : options.messages.get(replyTo);
  const choices = sharedOptions(questions);
  const current = choice !== undefined && choices.includes(choice) ? choice : undefined;
  const text = words.trim();

  const select = (id: string, on: boolean) => {
    setReplyTo(undefined);
    setChosen((ids) =>
      on ? [...ids.filter((each) => each !== id), id] : ids.filter((each) => each !== id),
    );
  };
  const clear = () => {
    setChosen([]);
    setReplyTo(undefined);
    setChoice(undefined);
    setWords("");
    answer.reset();
    send.reset();
  };

  const submit = () => {
    if (answer.isPending || send.isPending) return;
    if (questions.length > 0) {
      if (!text && current === undefined) return;
      const ids = questions.map((question) => question.id);
      answer.mutate(answerOf(ids, current, words), {
        onSuccess: () => {
          notices.answered(questions, current);
          clear();
        },
        onError: notices.refused,
      });
      return;
    }
    const to = message?.from ?? options.to;
    if (to === undefined || !text) return;
    send.mutate(
      { to, text, ...(message ? { reply_to: message.id } : {}) },
      {
        onSuccess: () => {
          notices.sent(to, options.names);
          clear();
        },
        onError: notices.refused,
      },
    );
  };

  const composer: ComposerModel = {
    targets: [...questions, ...(message ? [message] : [])],
    names: options.names,
    choices,
    choice: current,
    words,
    placeholder: options.placeholder,
    sending: answer.isPending || send.isPending,
    error: (answer.error ?? send.error)?.message,
    focus,
    onChoose: setChoice,
    onWrite: setWords,
    onRemove: (id) => (id === replyTo ? setReplyTo(undefined) : select(id, false)),
    onSend: submit,
    onLeave: () => {
      if (text === "") clear();
    },
  };

  return {
    composer,
    /** Whether anything is being answered or replied to. */
    replying: questions.length > 0 || message !== undefined,
    selected: new Set(questions.map((question) => question.id)),
    busy: answer.isPending || quick.isPending || send.isPending,
    select,
    clear,
    /** Put a question in the answer, and take the composer's focus. */
    answerInWords: (id: string) => {
      select(id, true);
      setFocus((count) => count + 1);
    },
    /** Reply to a message, and take the composer's focus. */
    replyTo: (id: string) => {
      setChosen([]);
      setReplyTo(id);
      setFocus((count) => count + 1);
    },
    /** Answer a question with one of its options. */
    choose: (question: QuestionRecord, label: string) =>
      quick.mutate(answerOf([question.id], label, ""), {
        onSuccess: () => {
          notices.answered([question], label);
          select(question.id, false);
          setPicks((all) => new Map([...all].filter(([id]) => id !== question.id)));
        },
        onError: notices.refused,
      }),
    /** The option picked on an approval: null for none yet, undefined for any other question. */
    picked: (question: QuestionRecord) =>
      question.answerer === null ? undefined : (picks.get(question.id) ?? null),
    /** Pick an option on an approval, or pick it again to let go. */
    pick: (question: QuestionRecord, label: string) =>
      setPicks((all) => {
        const next = new Map(all);
        if (next.get(question.id) === label) next.delete(question.id);
        else next.set(question.id, label);
        return next;
      }),
    focusComposer: () => setFocus((count) => count + 1),
  };
}

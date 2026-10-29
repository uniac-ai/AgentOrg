// How the user reads the organization's questions and messages, control: each actor's name, the
// user's as "you", and each card's model. The user, the root, may answer any question.

import type { MessageRecord, QuestionRecord } from "../../../src/clients/web/types.ts";
import type { Organization } from "../model/organization.ts";
import type { MessageCardModel, Names, QuestionCardModel } from "../views/messages.tsx";

/** Each member's name by id, the root's as "you". */
export function namesOf(organization: Organization): Names {
  const names = new Map<string, string>();
  for (const [id, member] of organization.members) names.set(id, member.name);
  names.set(organization.root.id, "you");
  return names;
}

/** A question's card; `selected` is undefined where nothing selects. */
export function questionCardOf(
  question: QuestionRecord,
  organization: Organization,
  names: Names,
  actions: Pick<
    QuestionCardModel,
    "selected" | "busy" | "onSelect" | "onChoose" | "onAnswer" | "picked" | "onPick"
  >,
): QuestionCardModel {
  const root = organization.root.id;
  return {
    question,
    names,
    from: organization.members.get(question.from),
    to: question.to === root ? undefined : organization.members.get(question.to),
    approver: question.answerer === null ? undefined : question.answerer === root ? "you" : "other",
    ...actions,
  };
}

/** A message's card, for a message to the user. */
export function messageCardOf(
  message: MessageRecord,
  organization: Organization,
  names: Names,
  actions: Pick<MessageCardModel, "busy" | "onReply" | "onRead">,
): MessageCardModel {
  return { message, names, from: organization.members.get(message.from), ...actions };
}

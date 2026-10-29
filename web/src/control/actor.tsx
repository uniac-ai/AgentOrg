// An actor's page, control: its progress (state, summary, open items and links), its open
// questions, which the user may step in on and answer, its reports underneath, and its history
// only when asked for. The composer at its foot messages the actor, which is how the user types
// to a session, or answers the questions put in it. Keys: r answers the focused question, or else
// writes to the actor; 1–9 answer the focused question with an option (on an approval, pick it,
// and ⌘/Ctrl+Enter sends the pick); h opens the history.

import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { focusedRow, isTyping, useKeys, useRowKeys } from "@/lib/keys";
import type { LinkRecord, MessageRecord } from "../../../src/clients/web/types.ts";
import { ApiError } from "../data/client.ts";
import { useCloseActor } from "../data/mutations.ts";
import { historyQuery, organizationQuery, progressQuery, sentQuery } from "../data/queries.ts";
import { timeline } from "../model/messages.ts";
import type { Member } from "../model/organization.ts";
import { ActorView } from "../views/actor.tsx";
import type { ComposerModel } from "../views/composer.tsx";
import type { HistoryModel } from "../views/history.tsx";
import type { ItemsModel } from "../views/items.tsx";
import type { QuestionCardModel } from "../views/messages.tsx";
import { notices } from "../views/notices.ts";
import { NotFoundView, PaneSkeleton } from "../views/states.tsx";
import { type BelowModel, belowOf } from "./below.ts";
import { namesOf, questionCardOf } from "./cards.ts";
import { useReply } from "./reply.ts";

const HISTORY_START = 20;
const HISTORY_STEP = 40;
/** The most earlier versions `progress` returns. */
const HISTORY_MAX = 100;

export interface ActorModel {
  member: Member;
  summary: string;
  links: LinkRecord[];
  /** Its open items; undefined while its progress loads. */
  items: ItemsModel | undefined;
  questions: QuestionCardModel[];
  below: BelowModel;
  /** The user's messages to it that it has not read yet, oldest first. */
  sent: MessageRecord[];
  history: HistoryModel;
  composer: ComposerModel;
  /** Closing it, for an actor that is not closed. */
  close: { openReports: Member[]; closing: boolean; onClose: () => void } | undefined;
}

export function ActorControl() {
  const { actorId = "" } = useParams({ strict: false });
  const navigate = useNavigate();
  const [organization, progress, sent] = useQueries({
    queries: [organizationQuery, progressQuery(actorId), sentQuery(actorId)],
  });
  const [historyLimit, setHistoryLimit] = useState<number>();
  const history = useQuery({
    ...historyQuery(actorId, historyLimit ?? HISTORY_START),
    enabled: historyLimit !== undefined,
  });
  const close = useCloseActor();
  const org = organization.data;
  const member = org?.members.get(actorId);
  const root = org?.root.id;
  const names = org ? namesOf(org) : new Map<string, string>();
  const questions = progress.data?.questions ?? member?.questions ?? [];
  const reply = useReply({
    questions: new Map(questions.map((question) => [question.id, question])),
    messages: new Map(),
    names,
    to: actorId,
    placeholder: `Message ${member?.name ?? ""}`,
  });
  useRowKeys();

  // biome-ignore lint/correctness/useExhaustiveDependencies: another actor starts with its history shut.
  useEffect(() => {
    setHistoryLimit(undefined);
    reply.clear();
  }, [actorId]);

  useKeys((event) => {
    if (isTyping(event)) return false;
    const question = questions.find((each) => each.id === focusedRow());
    const picked = question && reply.picked(question);
    if (question && picked && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      reply.choose(question, picked);
      return true;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const option = /^[1-9]$/.test(event.key) ? question?.options[Number(event.key) - 1] : undefined;
    if (question && option) {
      if (reply.picked(question) !== undefined) reply.pick(question, option.label);
      else reply.choose(question, option.label);
      return true;
    }
    if (event.key === "r") {
      if (question) reply.answerInWords(question.id);
      else reply.focusComposer();
      return true;
    }
    if (event.key === "h") {
      setHistoryLimit((limit) => limit ?? HISTORY_START);
      return true;
    }
    return false;
  });

  if (progress.error instanceof ApiError && progress.error.status === 400) return <NotFoundView />;
  if (org && !member) return <NotFoundView />;
  if (!org || !member) return <PaneSkeleton />;
  const model: ActorModel = {
    member,
    summary: progress.data?.progress?.summary ?? member.progress?.summary ?? "",
    links: progress.data?.progress?.links ?? [],
    items: progress.data && {
      items: progress.data.progress?.items ?? [],
      members: org.members,
      names,
      self: actorId,
    },
    questions: questions.map((question) =>
      questionCardOf(question, org, names, {
        selected: undefined,
        busy: reply.busy,
        onSelect: () => {},
        onChoose: (label) => reply.choose(question, label),
        onAnswer: () => reply.answerInWords(question.id),
        picked: reply.picked(question),
        onPick: (label) => reply.pick(question, label),
      }),
    ),
    below: belowOf(member, org),
    sent: [...(sent.data ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    history: {
      entries:
        history.data &&
        timeline(history.data.versions, history.data.questions, history.data.messages),
      loading: history.isFetching,
      // Names from the records first, then the team's, so a party outside the team is named too.
      names: new Map([...Object.entries(history.data?.names ?? {}), ...names]),
      more: (history.data?.more ?? false) && (historyLimit ?? 0) < HISTORY_MAX,
      onOpen: () => setHistoryLimit(HISTORY_START),
      onShowMore: () =>
        setHistoryLimit((limit) => Math.min(HISTORY_MAX, (limit ?? HISTORY_START) + HISTORY_STEP)),
    },
    composer: reply.composer,
    close:
      member.closed_at === null
        ? {
            openReports: member.reports.filter((report) => report.closed_at === null),
            closing: close.isPending,
            onClose: () =>
              close.mutate(member.id, {
                onSuccess: (closed) => {
                  notices.closed(closed);
                  const manager = closed.actor.manager;
                  void (manager === null || manager === root
                    ? navigate({ to: "/" })
                    : navigate({ to: "/people/$actorId", params: { actorId: manager } }));
                },
                onError: notices.refused,
              }),
          }
        : undefined,
  };
  return <ActorView {...model} />;
}

// A call's thread, control: the call with the calls that led to it, the answer being written, and
// the keys that pick an option (1–9), send (⌘/Ctrl+Enter) and close (Esc). Only a decision waiting
// on the user takes an answer here; a note or a report settles from the list.

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isTyping, useKeys } from "@/lib/keys";
import type { InputOf } from "../../../src/human/interfaces.ts";
import type { CallRecord } from "../../../src/human/types.ts";
import { useAnswer } from "../data/mutations.ts";
import { organizationQuery, viewQuery } from "../data/queries.ts";
import { causes } from "../model/activity.ts";
import { calls } from "../model/organization.ts";
import type { Names } from "../views/calls.tsx";
import { notices } from "../views/notices.ts";
import { NotFoundView, PaneSkeleton } from "../views/states.tsx";
import { ThreadView } from "../views/thread.tsx";
import { namesOf } from "./entity.tsx";

export interface ThreadModel {
  call: CallRecord;
  /** The calls that led to it, nearest first. */
  causes: CallRecord[];
  names: Names;
  /** The decision the user answers here: a `decide` call waiting on the user. */
  decision: InputOf<"decide"> | undefined;
  choice: string | undefined;
  words: string;
  sending: boolean;
  /** Why the last answer was refused. */
  error: string | undefined;
  onChoose: (label: string) => void;
  onWrite: (text: string) => void;
  onSend: () => void;
  onClose: () => void;
}

export function ThreadControl() {
  const { callId = "", actorId } = useParams({ strict: false });
  const navigate = useNavigate();
  const view = useQuery(viewQuery(actorId ?? "root"));
  const organization = useQuery(organizationQuery);
  const answer = useAnswer();
  const [choice, setChoice] = useState<string>();
  const [words, setWords] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new call starts a new answer.
  useEffect(() => {
    setChoice(undefined);
    setWords("");
    answer.reset();
  }, [callId]);

  const known = organization.data ? calls(organization.data) : new Map<string, CallRecord>();
  for (const call of [
    ...(view.data?.pending ?? []),
    ...(view.data?.open_calls ?? []),
    ...(view.data?.history ?? []),
  ]) {
    known.set(call.id, call);
  }
  const call = known.get(callId);
  const decision =
    call?.interface === "decide" && call.state === "pending" && call.to === organization.data?.root
      ? (call.input as InputOf<"decide">)
      : undefined;

  const close = () =>
    actorId === undefined
      ? navigate({ to: "/" })
      : navigate({ to: "/people/$actorId", params: { actorId } });
  const send = () => {
    if (!call || !decision || answer.isPending || (!choice && !words.trim())) return;
    const output = { choice: choice ?? null, words: words.trim() || null };
    answer.mutate(
      { call: call.id, output },
      { onSuccess: () => notices.answered(call, output), onError: notices.refused },
    );
  };

  useKeys((event) => {
    if (event.key === "Escape") {
      void close();
      return true;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      send();
      return true;
    }
    const option = decision?.options[Number(event.key) - 1];
    if (option && !isTyping(event) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      setChoice(option.label);
      return true;
    }
    return false;
  });

  if (!view.data || !organization.data) return <PaneSkeleton />;
  if (!call) return <NotFoundView />;
  const model: ThreadModel = {
    call,
    causes: causes(call, known),
    names: namesOf(organization.data, view.data),
    decision,
    choice,
    words,
    sending: answer.isPending,
    error: answer.error?.message,
    onChoose: setChoice,
    onWrite: setWords,
    onSend: send,
    onClose: () => void close(),
  };
  return <ThreadView {...model} />;
}

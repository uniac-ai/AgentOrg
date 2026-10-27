// An ask's thread, control: the ask with its chain, the answer being written, and the keys that
// pick an option (1–9), send (⌘/Ctrl+Enter) and close (Esc).

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isTyping, useKeys } from "@/lib/keys";
import type { AgentRecord, AskRecord } from "../../../src/page/types.ts";
import { ApiError } from "../data/client.ts";
import { useAnswer } from "../data/mutations.ts";
import { agentsQuery, askQuery, openAsksQuery } from "../data/queries.ts";
import { type Chain, chain } from "../model/activity.ts";
import { notices } from "../views/notices.ts";
import { NotFoundView, PaneSkeleton } from "../views/states.tsx";
import { ThreadView } from "../views/thread.tsx";

export interface ThreadModel {
  ask: AskRecord;
  chain: Chain;
  agents: ReadonlyMap<string, AgentRecord>;
  choice: string | undefined;
  words: string;
  sending: boolean;
  /** Why the service refused the last answer. */
  error: string | undefined;
  onChoose: (label: string) => void;
  onWrite: (text: string) => void;
  onSend: () => void;
  onClose: () => void;
}

export function ThreadControl() {
  const { askId = "", agentId } = useParams({ strict: false });
  const navigate = useNavigate();
  const ask = useQuery(askQuery(askId));
  const open = useQuery(openAsksQuery);
  const agents = useQuery(agentsQuery);
  const answer = useAnswer();
  const [choice, setChoice] = useState<string>();
  const [words, setWords] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new ask starts a new answer.
  useEffect(() => {
    setChoice(undefined);
    setWords("");
    answer.reset();
  }, [askId]);

  const close = () =>
    agentId === undefined
      ? navigate({ to: "/inbox" })
      : navigate({ to: "/people/$agentId", params: { agentId } });
  const send = () => {
    if (ask.data?.state !== "open" || answer.isPending || (!choice && !words.trim())) return;
    answer.mutate(
      { ask: askId, choice, words: words.trim() || undefined },
      { onSuccess: notices.answered, onError: notices.refused },
    );
  };

  useKeys((event) => {
    if (event.key === "Escape") {
      close();
      return true;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      send();
      return true;
    }
    const option = ask.data?.options[Number(event.key) - 1];
    if (option && !isTyping(event) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      setChoice(option.label);
      return true;
    }
    return false;
  });

  if (ask.error instanceof ApiError && ask.error.status === 404) return <NotFoundView />;
  if (!ask.data) return <PaneSkeleton />;
  const asks = new Map((open.data?.asks ?? []).map((a) => [a.id, a]));
  const model: ThreadModel = {
    ask: ask.data,
    chain: chain(ask.data, asks),
    agents: new Map(agents.data?.agents.map(({ agent }) => [agent.id, agent])),
    choice,
    words,
    sending: answer.isPending,
    error: answer.error?.message,
    onChoose: setChoice,
    onWrite: setWords,
    onSend: send,
    onClose: close,
  };
  return <ThreadView {...model} />;
}

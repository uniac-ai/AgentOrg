/**
 * The user's writes. Each updates what the page shows at once, puts it back if the service
 * refuses, and then refetches, so the record has the last word.
 */

import { useMutation } from "@tanstack/react-query";
import type { AskRecord, ClosedAgent, EntityView, MessageRecord } from "../../../src/page/types.ts";
import { request } from "./client.ts";
import { queryClient } from "./queries.ts";

const path = (...parts: string[]) => `/${parts.map(encodeURIComponent).join("/")}`;

type Snapshot = [readonly unknown[], EntityView | undefined][];

/** Take something out of every view while its write is in flight; the snapshot puts it back. */
async function without(drop: (view: EntityView) => EntityView): Promise<Snapshot> {
  await queryClient.cancelQueries({ queryKey: ["view"] });
  const before = queryClient.getQueriesData<EntityView>({ queryKey: ["view"] });
  queryClient.setQueriesData<EntityView>({ queryKey: ["view"] }, (view) => view && drop(view));
  return before;
}

function restore(before: Snapshot | undefined) {
  for (const [key, view] of before ?? []) queryClient.setQueryData(key, view);
}

const refetch = () => queryClient.invalidateQueries();

export interface AnswerInput {
  ask: string;
  choice?: string;
  words?: string;
}

export function useAnswer() {
  return useMutation({
    mutationFn: ({ ask, choice, words }: AnswerInput) =>
      request<AskRecord>(path("asks", ask, "answer"), { body: { choice, words } }),
    onMutate: ({ ask }) =>
      without((view) => ({
        ...view,
        asks_to_answer: view.asks_to_answer.filter((open) => open.id !== ask),
      })),
    onSuccess: (answered) => queryClient.setQueryData(["ask", answered.id], answered),
    onError: (_error, _input, before) => restore(before),
    onSettled: refetch,
  });
}

function useMessageWrite(verb: "ack" | "read") {
  return useMutation({
    mutationFn: (message: string) =>
      request<MessageRecord>(path("messages", message, verb), { body: {} }),
    onMutate: (message) =>
      without((view) => ({ ...view, inbox: view.inbox.filter((m) => m.id !== message) })),
    onError: (_error, _message, before) => restore(before),
    onSettled: refetch,
  });
}

export const useAcknowledge = () => useMessageWrite("ack");
export const useMarkRead = () => useMessageWrite("read");

/** Close an agent as the user; the service refuses while agents under it are open. */
export function useCloseAgent() {
  return useMutation({
    mutationFn: (agent: string) =>
      request<ClosedAgent>(path("agents", agent, "close"), { body: {} }),
    onSettled: refetch,
  });
}

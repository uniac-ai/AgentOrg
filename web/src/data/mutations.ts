/**
 * The user's writes. Each updates what the page shows at once, puts it back if the service
 * refuses, and then refetches, so the record has the last word.
 */

import { useMutation } from "@tanstack/react-query";
import type { AskRecord, Inbox, MessageRecord } from "../../../src/page/types.ts";
import { request } from "./client.ts";
import { queryClient } from "./queries.ts";

const path = (...parts: string[]) => `/${parts.map(encodeURIComponent).join("/")}`;

/** Take something out of the inbox while its write is in flight; the returned value puts it back. */
async function withoutInInbox(keep: (inbox: Inbox) => Inbox) {
  await queryClient.cancelQueries({ queryKey: ["inbox"] });
  const before = queryClient.getQueryData<Inbox>(["inbox"]);
  if (before) queryClient.setQueryData<Inbox>(["inbox"], keep(before));
  return before;
}

function restore(before: Inbox | undefined) {
  if (before) queryClient.setQueryData(["inbox"], before);
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
      withoutInInbox((inbox) => ({ ...inbox, asks: inbox.asks.filter((a) => a.id !== ask) })),
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
      withoutInInbox((inbox) => ({
        ...inbox,
        messages: inbox.messages.filter((m) => m.id !== message),
      })),
    onError: (_error, _message, before) => restore(before),
    onSettled: refetch,
  });
}

export const useAcknowledge = () => useMessageWrite("ack");
export const useMarkRead = () => useMessageWrite("read");

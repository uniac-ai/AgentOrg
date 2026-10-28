/**
 * The user's writes. Each takes what it settles out of what the app shows at once, puts it back
 * if it is refused, and then refetches, so the record has the last word.
 */

import { useMutation } from "@tanstack/react-query";
import type { Builtins } from "../../../src/human/types.ts";
import { call } from "./client.ts";
import { queryClient } from "./queries.ts";

type Snapshot = [readonly unknown[], unknown][];

const KEYS = [["questions"], ["messages"], ["team"], ["progress"]];

const without = <T extends { id: string }>(records: T[], ids: ReadonlySet<string>) =>
  records.filter((record) => !ids.has(record.id));

/** Take the questions and messages a write settles out of what waits, everywhere they show. */
async function settle(ids: ReadonlySet<string>): Promise<Snapshot> {
  await Promise.all(KEYS.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  const before = KEYS.flatMap((queryKey) => queryClient.getQueriesData({ queryKey }));
  for (const queryKey of [["questions"], ["messages"]]) {
    queryClient.setQueriesData<{ id: string }[]>(
      { queryKey },
      (records) => records && without(records, ids),
    );
  }
  queryClient.setQueriesData<Builtins["team"]["result"]>(
    { queryKey: ["team"] },
    (team) =>
      team && {
        ...team,
        positions: team.positions.map((position) => ({
          ...position,
          questions: without(position.questions, ids),
        })),
      },
  );
  queryClient.setQueriesData<Builtins["progress"]["result"]>(
    { queryKey: ["progress"] },
    (progress) => progress && { ...progress, questions: without(progress.questions, ids) },
  );
  return before;
}

function restore(before: Snapshot | undefined) {
  for (const [key, data] of before ?? []) queryClient.setQueryData(key, data);
}

const refetch = () => queryClient.invalidateQueries();

/** Answer one or more questions; the root may answer any. */
export function useAnswer() {
  return useMutation({
    mutationFn: (input: Builtins["question_answer"]["input"]) => call("question_answer", input),
    onMutate: (input) => settle(new Set(input.questions)),
    onError: (_error, _input, before) => restore(before),
    onSettled: refetch,
  });
}

/** Send a private message to any position; a reply marks the message it replies to read. */
export function useSend() {
  return useMutation({
    mutationFn: (input: Builtins["message_send"]["input"]) => call("message_send", input),
    onMutate: (input) => settle(new Set(input.reply_to === undefined ? [] : [input.reply_to])),
    onError: (_error, _input, before) => restore(before),
    onSettled: refetch,
  });
}

/** Mark messages to the user read. */
export function useRead() {
  return useMutation({
    mutationFn: (ids: string[]) => call("message_read", { ids }),
    onMutate: (ids) => settle(new Set(ids)),
    onError: (_error, _ids, before) => restore(before),
    onSettled: refetch,
  });
}

/** Close an actor as the root; the core refuses while actors under it are open. */
export function useCloseActor() {
  return useMutation({
    mutationFn: (actor: string) => call("actor_close", { actor }),
    onSettled: refetch,
  });
}

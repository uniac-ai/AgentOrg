/**
 * The user's writes. Each updates what the app shows at once, puts it back if it is refused, and
 * then refetches, so the record has the last word.
 */

import { useMutation } from "@tanstack/react-query";
import type { ActorClosed, ViewRecord } from "../../../src/human/types.ts";
import type { Organization } from "../model/organization.ts";
import { callInterface, path, request } from "./client.ts";
import { answered, queryClient } from "./queries.ts";

type Snapshot = [readonly unknown[], unknown][];

const withoutCall = (view: ViewRecord, call: string): ViewRecord => ({
  ...view,
  pending: view.pending.filter((pending) => pending.id !== call),
});

/** Take a call out of what waits, everywhere it shows, while its answer is in flight. */
async function without(call: string): Promise<Snapshot> {
  await queryClient.cancelQueries({ queryKey: ["view"] });
  await queryClient.cancelQueries({ queryKey: ["organization"] });
  const before = [
    ...queryClient.getQueriesData({ queryKey: ["view"] }),
    ...queryClient.getQueriesData({ queryKey: ["organization"] }),
  ];
  queryClient.setQueriesData<ViewRecord>(
    { queryKey: ["view"] },
    (view) => view && withoutCall(view, call),
  );
  queryClient.setQueriesData<Organization>(
    { queryKey: ["organization"] },
    (organization) =>
      organization && {
        ...organization,
        views: Object.fromEntries(
          Object.entries(organization.views).map(([id, view]) => [id, withoutCall(view, call)]),
        ),
      },
  );
  return before;
}

function restore(before: Snapshot | undefined) {
  for (const [key, data] of before ?? []) queryClient.setQueryData(key, data);
}

const refetch = () => queryClient.invalidateQueries();

export interface AnswerInput {
  call: string;
  /** The call's output: a decision's choice and words, `{}` for a note, `{acknowledged: true}` for a report. */
  output: Record<string, unknown>;
}

/** Answer a call waiting on the user, which completes it. */
export function useAnswer() {
  return useMutation({
    mutationFn: ({ call, output }: AnswerInput) =>
      request<{ call: string; output: Record<string, unknown> }>(path("pending", call), {
        body: output,
      }),
    onMutate: ({ call }) => {
      answered.add(call);
      return without(call);
    },
    onError: (_error, { call }, before) => {
      answered.delete(call);
      restore(before);
    },
    onSettled: refetch,
  });
}

/** Close an actor as the root; the core refuses while actors under it are open. */
export function useCloseActor() {
  return useMutation({
    mutationFn: (actor: string) => callInterface<ActorClosed>("actor_close", { actor }),
    onSettled: refetch,
  });
}

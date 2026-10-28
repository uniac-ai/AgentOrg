/**
 * Server state, through TanStack Query. Every read refetches when the window regains focus and
 * every few seconds while it is open, so the app stays current without a reload.
 */

import { QueryClient, queryOptions } from "@tanstack/react-query";
import type { AuditRecord, SessionBootstrap, ViewRecord } from "../../../src/human/types.ts";
import type { Organization } from "../model/organization.ts";
import { ApiError, keepCsrfToken, path, request } from "./client.ts";

export const REFRESH_MS = 5_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      refetchInterval: REFRESH_MS,
      retry: (failures, error) =>
        !(error instanceof ApiError && error.status < 500 && error.status > 0) && failures < 2,
    },
  },
});

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: async () => {
    const session = await request<SessionBootstrap>("/session");
    keepCsrfToken(session.csrf_token);
    return session;
  },
  refetchInterval: 60_000,
});

/**
 * Calls the user answered, which the core may list as pending a moment longer, until it collects
 * the answer. Every read leaves them out, and forgets each once the root's view no longer lists it.
 */
export const answered = new Set<string>();

function current(view: ViewRecord, isRoot: boolean): ViewRecord {
  if (isRoot) {
    for (const id of answered) {
      if (!view.pending.some((call) => call.id === id)) answered.delete(id);
    }
  }
  if (answered.size === 0) return view;
  return { ...view, pending: view.pending.filter((call) => !answered.has(call.id)) };
}

/** What an actor sees: `root` for the user, else an actor's id. */
export const viewQuery = (actor: string) =>
  queryOptions({
    queryKey: ["view", actor],
    queryFn: async () =>
      current(
        await request<ViewRecord>(actor === "root" ? "/view" : path("view", actor)),
        actor === "root",
      ),
  });

/** The organization: the root's view, and the view of every open actor under it, level by level. */
export const organizationQuery = queryOptions({
  queryKey: ["organization"],
  queryFn: async (): Promise<Organization> => {
    const root = current(await request<ViewRecord>("/view"), true);
    const views: Record<string, ViewRecord> = { [root.actor.id]: root };
    for (let level = root.reports; level.length > 0; ) {
      const below = await Promise.all(
        level.map(async (actor) =>
          current(await request<ViewRecord>(path("view", actor.id)), false),
        ),
      );
      for (const view of below) views[view.actor.id] = view;
      level = below.flatMap((view) => view.reports);
    }
    return { root: root.actor.id, views };
  },
});

export const activityQuery = (limit: number) =>
  queryOptions({
    queryKey: ["activity", limit],
    queryFn: () => request<{ entries: AuditRecord[] }>(`/activity?limit=${limit}`),
    placeholderData: (previous) => previous,
  });

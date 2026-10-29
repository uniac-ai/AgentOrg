/**
 * Server state, through TanStack Query. Every read is a call into one of the root's available
 * interfaces, and refetches when the window regains focus and every few seconds while it is open,
 * so the app stays current without a reload. History is read only when asked for.
 */

import { QueryClient, queryOptions } from "@tanstack/react-query";
import type { SessionBootstrap } from "../../../src/clients/web/types.ts";
import { organizationOf } from "../model/organization.ts";
import { ApiError, call, keepCsrfToken, request } from "./client.ts";

export const REFRESH_MS = 5_000;

/** How far down the organization the sidebar reads: as far as `team` goes. */
const TEAM_DEPTH = 20;

/** The most a single read of questions or messages returns. */
const QUESTIONS_MAX = 200;
const MESSAGES_MAX = 200;

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

/** The organization: the root's team, everyone under it. */
export const organizationQuery = queryOptions({
  queryKey: ["team"],
  queryFn: () => call("team", { depth: TEAM_DEPTH }),
  select: organizationOf,
});

/** The open questions addressed to the user, the root; `root` is undefined until it is known. */
export const questionsToQuery = (root: string | undefined) =>
  queryOptions({
    queryKey: ["questions", "open", root],
    queryFn: async () =>
      (await call("questions", { to: root, open: true, limit: QUESTIONS_MAX })).questions,
    enabled: root !== undefined,
  });

/** The messages to the user it has not read yet. */
export const unreadQuery = queryOptions({
  queryKey: ["messages", "unread"],
  queryFn: async () => (await call("messages", { unread: true, limit: MESSAGES_MAX })).messages,
});

/** An actor's progress, with its open questions. */
export const progressQuery = (actor: string) =>
  queryOptions({
    queryKey: ["progress", actor],
    queryFn: () => call("progress", { actor }),
  });

/** The user's messages to an actor that it has not read yet. */
export const sentQuery = (actor: string) =>
  queryOptions({
    queryKey: ["messages", "sent", actor],
    queryFn: async () =>
      (await call("messages", { box: "out", unread: true, with: actor })).messages,
  });

/**
 * An actor's earlier progress, the questions it asked and was asked, and its messages both ways,
 * the newest `limit` of each.
 */
export const historyQuery = (actor: string, limit: number) =>
  queryOptions({
    queryKey: ["history", actor, limit],
    queryFn: async () => {
      const [progress, asked, askedOf, inbox, outbox] = await Promise.all([
        call("progress", { actor, history: limit }),
        call("questions", { from: actor, limit }),
        call("questions", { to: actor, limit }),
        call("messages", { actor, box: "in", limit }),
        call("messages", { actor, box: "out", limit }),
      ]);
      const pages = [
        progress.history,
        asked.questions,
        askedOf.questions,
        inbox.messages,
        outbox.messages,
      ];
      return {
        versions: progress.history,
        /** Each actor these name, by id, as the core names it. */
        names: Object.assign(
          {},
          ...[asked, askedOf, inbox, outbox].map((read) => read.names),
        ) as Record<string, string>,
        questions: [...asked.questions, ...askedOf.questions],
        messages: [...inbox.messages, ...outbox.messages],
        more: pages.some((page) => page.length === limit),
      };
    },
    placeholderData: (previous) => previous,
  });

export const activityQuery = (limit: number) =>
  queryOptions({
    queryKey: ["activity", limit],
    queryFn: () => call("activity", { limit }),
    placeholderData: (previous) => previous,
  });

/**
 * Server state, through TanStack Query. Every read refetches when the window regains focus and
 * every few seconds while it is open, so the page stays current without a reload.
 */

import { QueryClient, queryOptions } from "@tanstack/react-query";
import type {
  AgentFull,
  AgentList,
  AskList,
  AskRecord,
  Inbox,
  PageBootstrap,
} from "../../../src/page/types.ts";
import { ApiError, keepCsrfToken, request } from "./client.ts";

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
    const session = await request<PageBootstrap>("/session");
    keepCsrfToken(session.csrf_token);
    return session;
  },
  refetchInterval: 60_000,
});

export const agentsQuery = queryOptions({
  queryKey: ["agents"],
  queryFn: () => request<AgentList>("/agents"),
});

export const inboxQuery = queryOptions({
  queryKey: ["inbox"],
  queryFn: () => request<Inbox>("/inbox"),
});

export const agentQuery = (id: string) =>
  queryOptions({
    queryKey: ["agent", id],
    queryFn: () => request<AgentFull>(`/agents/${encodeURIComponent(id)}`),
  });

export const askQuery = (id: string) =>
  queryOptions({
    queryKey: ["ask", id],
    queryFn: () => request<AskRecord>(`/asks/${encodeURIComponent(id)}`),
  });

/** Every open ask, whoever it is addressed to, for building escalation chains. */
export const openAsksQuery = queryOptions({
  queryKey: ["asks", "open"],
  queryFn: () => request<AskList>("/asks?state=open"),
});

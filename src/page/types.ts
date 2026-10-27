/** What the page's JSON routes under `/ui/api` return; the web app imports these types. */

import type { z } from "zod";
import type {
  Agent,
  AgentCloseResult,
  AgentDetail,
  AgentListResult,
  Ask,
  AskListResult,
  AuditListResult,
  Message,
  View,
} from "../contract/index.ts";

export type AgentRecord = z.output<typeof Agent>;
export type AgentList = z.output<typeof AgentListResult>;
export type AgentSummary = AgentList["agents"][number];
export type AgentFull = z.output<typeof AgentDetail>;
export type AskRecord = z.output<typeof Ask>;
export type AskList = z.output<typeof AskListResult>;
export type MessageRecord = z.output<typeof Message>;
export type Activity = z.output<typeof AuditListResult>;
export type ClosedAgent = z.output<typeof AgentCloseResult>;
export type EntityView = z.output<typeof View>;

/** `GET /ui/api/session`: the page session the cookie names, with the token every write carries. */
export interface PageBootstrap {
  csrf_token: string;
  expires_at: string;
}

/** `GET /ui/api/activity`: the audit trail without sign-in links, each status set with its summary. */
export interface PageActivity {
  entries: (Activity["entries"][number] & { summary?: string | null })[];
  /** Whether older entries may exist beyond these. */
  more: boolean;
}

/** The header every write carries, holding the page session's CSRF token. */
export const CSRF_HEADER = "X-CSRF-Token";

/** The body of every error from `/ui/api`; `signed_out` means the page session is gone. */
export interface PageError {
  code: string;
  message: string;
}

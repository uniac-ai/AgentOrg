/** What the page's JSON routes under `/ui/api` return; the web app imports these types. */

import type { z } from "zod";
import type {
  Agent,
  AgentDetail,
  AgentListResult,
  Ask,
  AskListResult,
  AuditListResult,
  Message,
} from "../contract/index.ts";

export type AgentRecord = z.output<typeof Agent>;
export type AgentList = z.output<typeof AgentListResult>;
export type AgentSummary = AgentList["agents"][number];
export type AgentFull = z.output<typeof AgentDetail>;
export type AskRecord = z.output<typeof Ask>;
export type AskList = z.output<typeof AskListResult>;
export type MessageRecord = z.output<typeof Message>;
export type Activity = z.output<typeof AuditListResult>;

/** `GET /ui/api/session`: the page session the cookie names, with the token every write carries. */
export interface PageBootstrap {
  csrf_token: string;
  expires_at: string;
}

/** `GET /ui/api/inbox`: what waits on the user. */
export interface Inbox {
  /** Open asks addressed to the user, oldest first. */
  asks: AskRecord[];
  /** Unread notes and unacknowledged reports to the user, oldest first. */
  messages: MessageRecord[];
}

/** The header every write carries, holding the page session's CSRF token. */
export const CSRF_HEADER = "X-CSRF-Token";

/** The body of every error from `/ui/api`; `signed_out` means the page session is gone. */
export interface PageError {
  code: string;
  message: string;
}

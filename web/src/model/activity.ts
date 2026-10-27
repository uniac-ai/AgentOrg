/**
 * One agent's work over time, and what waits on it: the pinned items an agent's pane leads with,
 * the feed below them, and the chain of asks an ask carries up.
 */

import type { AgentFull, AskRecord, MessageRecord } from "../../../src/page/types.ts";

type StatusEntry = AgentFull["status_history"][number];

/** What waits on an agent: open asks addressed to it, then unread messages and unreviewed reports to it. */
export interface Pending {
  asks: AskRecord[];
  messages: MessageRecord[];
}

export function waitsOnRecipient(message: MessageRecord): boolean {
  return message.kind === "report" ? message.acknowledged_at === null : message.read_at === null;
}

/** Oldest first, so the item that has waited longest leads. */
export function pending(detail: AgentFull): Pending {
  const id = detail.agent.id;
  return {
    asks: detail.addressed_asks
      .filter((ask) => ask.state === "open")
      .sort((a, b) => a.opened_at.localeCompare(b.opened_at)),
    messages: detail.messages
      .filter((message) => message.to === id && waitsOnRecipient(message))
      .sort((a, b) => a.sent_at.localeCompare(b.sent_at)),
  };
}

export type FeedEntry =
  | { kind: "status"; at: string; status: StatusEntry }
  | { kind: "asked"; at: string; ask: AskRecord }
  | { kind: "answered"; at: string; ask: AskRecord }
  | { kind: "message"; at: string; message: MessageRecord };

/**
 * What happened to an agent, newest first: the statuses its sessions set, each ask it opened or
 * was sent and each answer to one, and each message it sent or received. Its current status,
 * and what still waits on it, show above the feed, so they are left out here.
 */
export function feed(detail: AgentFull): FeedEntry[] {
  const waiting = pending(detail);
  const pinned = new Set([...waiting.asks, ...waiting.messages].map((record) => record.id));
  const asks = [...detail.own_asks, ...detail.addressed_asks];
  const entries: FeedEntry[] = [
    ...detail.status_history
      .filter((status) => status.at !== detail.agent.status?.updated_at)
      .map((status) => ({ kind: "status" as const, at: status.at, status })),
    ...asks
      .filter((ask) => !pinned.has(ask.id))
      .map((ask) => ({ kind: "asked" as const, at: ask.opened_at, ask })),
    ...asks.flatMap((ask) =>
      ask.answer ? [{ kind: "answered" as const, at: ask.answer.answered_at, ask }] : [],
    ),
    ...detail.messages
      .filter((message) => !pinned.has(message.id))
      .map((message) => ({ kind: "message" as const, at: message.sent_at, message })),
  ];
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

/** An ask with the asks it carries up, each with the ones it carries. */
export interface Chain {
  ask: AskRecord;
  carries: Chain[];
}

/** The chain an ask carries up, from the asks known; an ask not among them is left out. */
export function chain(ask: AskRecord, asks: ReadonlyMap<string, AskRecord>): Chain {
  const carried = ask.escalates.flatMap((id) => asks.get(id) ?? []);
  return { ask, carries: carried.map((lower) => chain(lower, asks)) };
}

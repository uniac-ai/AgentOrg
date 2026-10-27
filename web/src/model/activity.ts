/**
 * What happened to an entity, the user or an agent, as the feed below its pinned items; and the
 * chain of asks an ask carries up.
 */

import type { AskRecord, EntityView, MessageRecord } from "../../../src/page/types.ts";

type StatusEntry = EntityView["history"]["status_history"][number];

export type FeedEntry =
  | { kind: "status"; at: string; status: StatusEntry }
  | { kind: "asked"; at: string; ask: AskRecord }
  | { kind: "answered"; at: string; ask: AskRecord }
  | { kind: "message"; at: string; message: MessageRecord };

/**
 * What happened to an entity, newest first: the statuses its sessions set, each ask it opened or
 * was sent and each answer to one, and each message it sent or received. Its current status,
 * what still waits on it and its own asks still open show above the feed, so they are left out here.
 */
export function feed(view: EntityView): FeedEntry[] {
  const pinned = new Set(
    [
      ...view.asks_to_answer,
      ...view.own_asks.filter((ask) => ask.state === "open"),
      ...view.inbox,
    ].map((record) => record.id),
  );
  const current = view.agent?.status?.updated_at;
  const { asks, messages, status_history } = view.history;
  const entries: FeedEntry[] = [
    ...status_history
      .filter((status) => status.at !== current)
      .map((status) => ({ kind: "status" as const, at: status.at, status })),
    ...asks
      .filter((ask) => !pinned.has(ask.id))
      .map((ask) => ({ kind: "asked" as const, at: ask.opened_at, ask })),
    ...asks.flatMap((ask) =>
      ask.answer ? [{ kind: "answered" as const, at: ask.answer.answered_at, ask }] : [],
    ),
    ...messages
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

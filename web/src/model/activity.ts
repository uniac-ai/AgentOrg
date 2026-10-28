/**
 * What happened to an entity, as the feed below what still waits: its settled calls, in and out,
 * newest first; and the calls that led to a call, through each one's cause.
 */

import type { CallRecord, ViewRecord } from "../../../src/human/types.ts";

export interface FeedEntry {
  at: string;
  call: CallRecord;
}

export const feed = (view: ViewRecord): FeedEntry[] =>
  view.history
    .map((call) => ({ at: call.settled_at ?? call.created_at, call }))
    .sort((a, b) => b.at.localeCompare(a.at));

/** The calls that led to `call`, nearest first, as far as the calls known go. */
export function causes(call: CallRecord, known: ReadonlyMap<string, CallRecord>): CallRecord[] {
  const chain: CallRecord[] = [];
  for (let next = call.cause; next !== null; ) {
    const cause = known.get(next);
    if (cause === undefined || chain.includes(cause)) break;
    chain.push(cause);
    next = cause.cause;
  }
  return chain;
}

/** A done call's output. The one place that reads the shape of the core's call result. */
export const outputOf = (call: CallRecord): Record<string, unknown> =>
  (call.output?.structuredContent as Record<string, unknown> | undefined) ?? {};

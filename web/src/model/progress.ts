/**
 * Progress at a glance: counts by state for the whole organization and for every manager's
 * subtree, which actors changed most recently, and which running ones have gone quiet.
 */

import type { Member } from "./organization.ts";
import { PROGRESS_STATES, type ProgressState, progressState } from "./state.ts";

export type Counts = Record<ProgressState, number>;

const zero = (): Counts => Object.fromEntries(PROGRESS_STATES.map((state) => [state, 0])) as Counts;

export const total = (counts: Counts) =>
  PROGRESS_STATES.reduce((sum, state) => sum + counts[state], 0);

/** The members counted by state. */
export function totals(members: readonly Member[]): Counts {
  const counts = zero();
  for (const member of members) counts[progressState(member)] += 1;
  return counts;
}

/** A member's subtree, everyone below it, counted by state. */
export function rollup(member: Member): Counts {
  const counts = zero();
  for (const report of member.reports) {
    counts[progressState(report)] += 1;
    const below = rollup(report);
    for (const state of PROGRESS_STATES) counts[state] += below[state];
  }
  return counts;
}

/** When a member last published its progress, else when it was created. */
export const updatedAt = (member: Member) => member.progress?.updated_at ?? member.created_at;

/** How long a running actor may go without publishing before it counts as stale. */
export const STALE_AFTER_MS = 60 * 60_000;

/** A running actor whose progress has not changed for a while: it says it works, but is quiet. */
export function isStale(member: Member, now: number = Date.now()): boolean {
  return (
    progressState(member) === "running" && now - Date.parse(updatedAt(member)) > STALE_AFTER_MS
  );
}

/** The members whose progress changed most recently, newest first. */
export function recentlyChanged(members: readonly Member[], limit = 5): Member[] {
  return members
    .filter((member) => member.progress !== null && member.closed_at === null)
    .sort((a, b) => updatedAt(b).localeCompare(updatedAt(a)))
    .slice(0, limit);
}

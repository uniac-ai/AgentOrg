/**
 * Progress at a glance: counts by state for the whole organization and for every manager's
 * subtree, which actors changed most recently, and which running ones have gone quiet.
 */

import type { ActorRecord } from "../../../src/human/types.ts";
import { PROGRESS_STATES, type ProgressState, progressState } from "./state.ts";

export type Counts = Record<ProgressState, number>;

const zero = (): Counts => Object.fromEntries(PROGRESS_STATES.map((state) => [state, 0])) as Counts;

export const total = (counts: Counts) =>
  PROGRESS_STATES.reduce((sum, state) => sum + counts[state], 0);

/** The actors counted by state. */
export function totals(actors: readonly ActorRecord[]): Counts {
  const counts = zero();
  for (const actor of actors) counts[progressState(actor)] += 1;
  return counts;
}

/** Every actor's subtree, all the actors below it, counted by state. */
export function rollups(actors: readonly ActorRecord[]): Map<string, Counts> {
  const children = new Map<string, ActorRecord[]>();
  for (const actor of actors) {
    if (actor.manager !== null) {
      children.set(actor.manager, [...(children.get(actor.manager) ?? []), actor]);
    }
  }
  const counted = new Map<string, Counts>();
  const count = (id: string): Counts => {
    const known = counted.get(id);
    if (known) return known;
    const counts = zero();
    counted.set(id, counts);
    for (const child of children.get(id) ?? []) {
      counts[progressState(child)] += 1;
      const below = count(child.id);
      for (const state of PROGRESS_STATES) counts[state] += below[state];
    }
    return counts;
  };
  for (const actor of actors) count(actor.id);
  return counted;
}

/** How long a running actor may go without setting its status before it counts as stale. */
export const STALE_AFTER_MS = 60 * 60_000;

/** A running actor whose status has not changed for a while: it says it works, but is quiet. */
export function isStale(actor: ActorRecord, now: number = Date.now()): boolean {
  return (
    progressState(actor) === "running" &&
    now - Date.parse(actor.status?.updated_at ?? actor.created_at) > STALE_AFTER_MS
  );
}

/** The actors whose status changed most recently, newest first. */
export function recentlyChanged(actors: readonly ActorRecord[], limit = 5): ActorRecord[] {
  const at = (actor: ActorRecord) => actor.status?.updated_at ?? "";
  return actors
    .filter((actor) => actor.status !== null && actor.closed_at === null)
    .sort((a, b) => at(b).localeCompare(at(a)))
    .slice(0, limit);
}

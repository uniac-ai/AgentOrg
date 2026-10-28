// Where an actor's work stands, as one word: its status once it reports one, else idle, and closed
// once its manager closes it. Every mark, count and roll-up in the app uses these words.

import type { ActorRecord } from "../../../src/human/types.ts";

/** In display order: work moving, work waiting, then actors idle or done. */
export const PROGRESS_STATES = [
  "running",
  "review",
  "waiting",
  "blocked",
  "idle",
  "closed",
] as const;

export type ProgressState = (typeof PROGRESS_STATES)[number];

export function progressState(actor: ActorRecord): ProgressState {
  if (actor.closed_at !== null) return "closed";
  return actor.status?.state ?? "idle";
}
